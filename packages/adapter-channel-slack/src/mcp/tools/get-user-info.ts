import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
import { errorResult } from './tool-result.js';

export const SLACK_GET_USER_INFO_TOOL_NAME = 'slack_get_user_info';

export const getUserInfoInputShape = {
  user: z
    .string()
    .min(1)
    .describe(
      'Slack user ID (e.g. U0123456). Use the `user` field from `slack_get_channel_history` results.',
    ),
};

const InputSchema = z.object(getUserInfoInputShape);
export type GetUserInfoInput = z.infer<typeof InputSchema>;

export interface SlackUserInfo {
  readonly id: string;
  readonly name: string;
  readonly real_name?: string;
  readonly display_name?: string;
  readonly is_bot: boolean;
  readonly tz?: string;
}

export async function getUserInfo(
  client: WebClient,
  args: GetUserInfoInput,
): Promise<CallToolResult> {
  try {
    const res = await client.users.info({ user: args.user });
    if (!res.ok || !res.user) {
      return errorResult(`Slack API error: ${res.error ?? 'unknown'}`);
    }
    const user = toUserInfo(res.user);
    return {
      content: [{ type: 'text', text: JSON.stringify({ user }) }],
    };
  } catch (err) {
    return errorResult(
      `Slack API call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface RawSlackUser {
  readonly id?: string;
  readonly name?: string;
  readonly real_name?: string;
  readonly is_bot?: boolean;
  readonly tz?: string;
  readonly profile?: {
    readonly display_name?: string;
    readonly real_name?: string;
  };
}

function toUserInfo(u: RawSlackUser): SlackUserInfo {
  const displayName = u.profile?.display_name;
  const realName = u.profile?.real_name ?? u.real_name;
  return {
    id: u.id ?? '',
    name: u.name ?? '',
    ...(realName !== undefined && realName.length > 0 ? { real_name: realName } : {}),
    ...(displayName !== undefined && displayName.length > 0 ? { display_name: displayName } : {}),
    is_bot: u.is_bot ?? false,
    ...(u.tz !== undefined ? { tz: u.tz } : {}),
  };
}
