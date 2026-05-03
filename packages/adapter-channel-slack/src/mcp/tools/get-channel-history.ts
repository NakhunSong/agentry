import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { errorResult } from './tool-result.js';

export const SLACK_GET_CHANNEL_HISTORY_TOOL_NAME = 'slack_get_channel_history';

// Raw shape — the MCP SDK's `registerTool` consumes this directly.
export const getChannelHistoryInputShape = {
  channel: z
    .string()
    .min(1)
    .describe('Slack channel ID (e.g. C0123456). The bot must already be a member of the channel.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Maximum number of messages to return. Default 50, max 200.'),
  since: z
    .number()
    .optional()
    .describe(
      'Unix timestamp (seconds). When set, only messages posted at or after this time are returned.',
    ),
};

const InputSchema = z.object(getChannelHistoryInputShape);
export type GetChannelHistoryInput = z.infer<typeof InputSchema>;

const DEFAULT_LIMIT = 50;

// Bot-authored messages (bot_id present) are intentionally preserved here —
// this tool feeds the running agent's context, where seeing what other bots
// posted in the same channel is the killer use case (#26).
export interface SlackHistoryMessage {
  readonly ts: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly username?: string;
  readonly text: string;
  readonly thread_ts?: string;
}

export async function getChannelHistory(
  client: WebClient,
  args: GetChannelHistoryInput,
): Promise<CallToolResult> {
  try {
    const res = await client.conversations.history({
      channel: args.channel,
      limit: args.limit ?? DEFAULT_LIMIT,
      ...(args.since !== undefined ? { oldest: String(args.since) } : {}),
    });
    if (!res.ok || !res.messages) {
      return errorResult(`Slack API error: ${res.error ?? 'unknown'}`);
    }
    const messages: SlackHistoryMessage[] = res.messages.map(toHistoryMessage);
    return {
      content: [{ type: 'text', text: JSON.stringify({ messages }) }],
    };
  } catch (err) {
    return errorResult(
      `Slack API call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function toHistoryMessage(m: {
  readonly ts?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly username?: string;
  readonly text?: string;
  readonly thread_ts?: string;
}): SlackHistoryMessage {
  return {
    ts: m.ts ?? '',
    ...(m.user !== undefined ? { user: m.user } : {}),
    ...(m.bot_id !== undefined ? { bot_id: m.bot_id } : {}),
    ...(m.username !== undefined ? { username: m.username } : {}),
    text: m.text ?? '',
    ...(m.thread_ts !== undefined ? { thread_ts: m.thread_ts } : {}),
  };
}
