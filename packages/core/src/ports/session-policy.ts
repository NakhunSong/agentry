import type { IncomingEvent } from '../domain/channel.js';
import type { ChannelKind, ChannelNativeRef, SessionLifecycleEvent } from '../domain/session.js';

// Per-channel routing + lifecycle strategy. Concrete adapters bring their
// own implementation (e.g. SlackPolicy, CliPolicy) alongside their channel
// adapter; the composition root maps `channelKind` → `SessionPolicy`.
//
// `computeNativeRef` is pure and synchronous: given an inbound event, it
// returns the channel-specific session key (Slack: `slack:${channel_id}:
// ${thread_ts}`; CLI: `AGENT_SESSION_ID` or PID; etc.). The framework uses
// this to look up or create a Session via SessionStore.findOrCreate.
//
// `shouldEndOn` is the lifecycle predicate: given a lifecycle event the
// framework observed (idle timer fired, transport closed, ...), decide
// whether THIS channel's policy treats it as "session ended".
export interface SessionPolicy {
  readonly channelKind: ChannelKind;
  computeNativeRef(event: IncomingEvent): ChannelNativeRef;
  idleTimeoutMinutes(): number;
  shouldEndOn(event: SessionLifecycleEvent): boolean;
}
