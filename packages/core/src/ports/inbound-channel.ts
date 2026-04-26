import type { IncomingEvent } from '../domain/channel.js';
import type { ChannelKind } from '../domain/session.js';

// Long-running listener. The handler MUST return promptly after enqueuing
// work — typically before the agent has produced its response. Channels
// with strict ack windows (Slack: 3s) rely on this contract.
//
// `start` resolves when listening stops (either the AbortSignal fires or
// the underlying transport closes). Implementations MUST honor the signal.
export interface InboundChannel {
  readonly kind: ChannelKind;
  start(handler: (event: IncomingEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
}
