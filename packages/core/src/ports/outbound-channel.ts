import type { ReplyAck, ReplyContent, ReplyTarget } from '../domain/channel.js';
import type { ChannelKind } from '../domain/session.js';

// One-shot reply. Deliberately no `update(messageRef, content)` at MVP —
// many transports (email, generic HTTP) don't support edit. Revisit when
// a real UX gap appears (per ARCHITECTURE.md §4.1).
export interface OutboundChannel {
  readonly kind: ChannelKind;
  reply(target: ReplyTarget, content: ReplyContent): Promise<ReplyAck>;
}
