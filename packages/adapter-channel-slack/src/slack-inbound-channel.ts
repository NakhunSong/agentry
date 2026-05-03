import type { ChannelKind, InboundChannel, IncomingEvent, Logger, TenantId } from '@agentry/core';
import { App } from '@slack/bolt';
import { SLACK_CHANNEL_KIND } from './slack-channel-kinds.js';
import {
  mapAppMentionToIncomingEvent,
  type SlackAppMentionEnvelope,
} from './slack-event-mapping.js';
import type { SlackHistoryBackfiller } from './slack-history-backfiller.js';
import { verifySlackScopes } from './slack-scope-verifier.js';

// Channel mention + thread backfill + user/channel lookup scopes. Reading
// prior thread messages requires `*:history` per channel type the bot is
// invited to. `users:read` powers `slack_get_user_info` (display-name
// resolution); `*:read` powers `agentry-slack list-channels`.
export const SLACK_REQUIRED_SCOPES: readonly string[] = [
  'app_mentions:read',
  'chat:write',
  'channels:history',
  'groups:history',
  'channels:read',
  'groups:read',
  'users:read',
];

const DEFAULT_TENANT: TenantId = 'default';

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
  // Optional thread-history backfill: when set, the channel calls
  // backfillIfNeeded on first contact and forwards synthetic events
  // (history-only) to the handler before the live event.
  readonly backfiller?: SlackHistoryBackfiller;
  readonly resolveTenant?: (event: IncomingEvent) => TenantId;
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

    const required = this.opts.requiredScopes ?? SLACK_REQUIRED_SCOPES;
    await verifySlackScopes(this.opts.botToken, required, this.opts.fetch);

    const app =
      this.opts.app ??
      new App({
        token: this.opts.botToken,
        signingSecret: this.opts.signingSecret,
      });

    app.event('app_mention', async ({ event, body, logger }) => {
      const log = this.opts.logger ?? logger;
      try {
        const b = body as { event_id?: unknown; team_id?: unknown };
        const envelope: SlackAppMentionEnvelope = {
          event: event as SlackAppMentionEnvelope['event'],
          event_id: typeof b.event_id === 'string' ? b.event_id : '',
          team_id: typeof b.team_id === 'string' ? b.team_id : '',
        };
        const live = mapAppMentionToIncomingEvent(envelope);
        const tenant = (this.opts.resolveTenant ?? (() => DEFAULT_TENANT))(live);

        // Inner try/catch around backfill ONLY: a backfill failure must not
        // drop the live event. Without this, a transient Slack API error
        // (rate limit, network blip) would silently drop the user's mention.
        let synthetics: readonly IncomingEvent[] = [];
        if (this.opts.backfiller) {
          try {
            synthetics = await this.opts.backfiller.backfillIfNeeded(live, tenant);
          } catch (err) {
            log.warn({ err }, 'slack history backfill failed; proceeding without synthetics');
          }
        }

        for (const synth of synthetics) await handler(synth);
        await handler(live);
      } catch (err) {
        // Log and swallow: failing here would cause Bolt to leave the request
        // un-acked, prompting Slack to redeliver (idempotency handles the
        // dup but we'd burn time on every redelivery). Errors after enqueue
        // are the JobRunner's concern.
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
