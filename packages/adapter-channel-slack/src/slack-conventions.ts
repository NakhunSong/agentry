import type { ChannelNativeRef } from '@agentry/core';

// Idempotency-key prefix for synthetic events sourced from
// conversations.replies. Distinct from the live `app_mention` event_id so
// the use case's de-dup map can't conflate the two.
export const SLACK_HISTORY_IDEMPOTENCY_PREFIX = 'slack-history:';

export function slackHistoryIdempotencyKey(messageTs: string): string {
  return `${SLACK_HISTORY_IDEMPOTENCY_PREFIX}${messageTs}`;
}

// Canonical session key shape per ARCHITECTURE.md §4.3:
// `slack:${channel_id}:${thread_ts}`. Both the event mapper (for live
// events) and the backfiller (for synthetic events) build this; keeping
// the format in one place prevents drift.
export function slackNativeRef(channel: string, threadTs: string): ChannelNativeRef {
  return `slack:${channel}:${threadTs}`;
}

// Slack timestamps are decimal seconds-since-epoch with microsecond
// fractional part (`"1700000000.000100"`). The mapper, the outbound
// adapter, and the backfiller all need the Date form.
export function slackTsToDate(ts: string): Date {
  return new Date(Number.parseFloat(ts) * 1000);
}
