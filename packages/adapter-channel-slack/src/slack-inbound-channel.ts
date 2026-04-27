import type { ChannelKind, InboundChannel, IncomingEvent, Logger } from '@agentry/core';
import { App } from '@slack/bolt';
import { SLACK_CHANNEL_KIND } from './slack-channel-kinds.js';
import {
  mapAppMentionToIncomingEvent,
  type SlackAppMentionEnvelope,
} from './slack-event-mapping.js';
import { verifySlackScopes } from './slack-scope-verifier.js';

// Required for receiving channel mentions and replying (excludes thread
// backfill scopes — those belong to PR2 when the backfill path lands).
export const SLACK_REQUIRED_SCOPES_PR1: readonly string[] = ['app_mentions:read', 'chat:write'];

export interface SlackInboundChannelOptions {
  readonly botToken: string;
  readonly signingSecret: string;
  readonly port: number;
  readonly logger?: Logger;
  // Test seams: inject pre-built App / fetch so unit tests skip Bolt's HTTP
  // listener and the real Slack auth.test call.
  readonly app?: App;
  readonly fetch?: typeof globalThis.fetch;
  readonly requiredScopes?: readonly string[];
}

export class SlackInboundChannel implements InboundChannel {
  readonly kind: ChannelKind = SLACK_CHANNEL_KIND;
  private readonly opts: SlackInboundChannelOptions;
  private started = false;

  constructor(opts: SlackInboundChannelOptions) {
    this.opts = opts;
  }

  async start(
    handler: (event: IncomingEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    // Single-shot: a second call would register a duplicate `app_mention`
    // listener on the same App, doubling every event. Composition root must
    // build a new instance per restart.
    if (this.started) {
      throw new Error(
        'SlackInboundChannel.start() is single-shot; create a new instance to restart',
      );
    }
    this.started = true;
    if (signal.aborted) return;

    const required = this.opts.requiredScopes ?? SLACK_REQUIRED_SCOPES_PR1;
    await verifySlackScopes(this.opts.botToken, required, this.opts.fetch);

    const app =
      this.opts.app ??
      new App({
        token: this.opts.botToken,
        signingSecret: this.opts.signingSecret,
      });

    app.event('app_mention', async ({ event, body, logger }) => {
      try {
        const b = body as { event_id?: unknown; team_id?: unknown };
        const envelope: SlackAppMentionEnvelope = {
          event: event as SlackAppMentionEnvelope['event'],
          event_id: typeof b.event_id === 'string' ? b.event_id : '',
          team_id: typeof b.team_id === 'string' ? b.team_id : '',
        };
        const incoming = mapAppMentionToIncomingEvent(envelope);
        await handler(incoming);
      } catch (err) {
        // Log and swallow: failing here would cause Bolt to leave the request
        // un-acked, prompting Slack to redeliver (idempotency handles the
        // dup but we'd burn time on every redelivery). Errors after enqueue
        // are the JobRunner's concern.
        const log = this.opts.logger ?? logger;
        log.error({ err }, 'slack app_mention handling failed');
      }
    });

    // app.start(port) binds the HTTP listener and resolves immediately.
    // The InboundChannel contract requires start() to resolve only when
    // listening stops, so we await an abort-driven promise before stopping.
    await app.start(this.opts.port);

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

    await app.stop();
  }
}
