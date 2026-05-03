// stdio MCP server entry. Spawned by Claude CLI when listed under
// `--mcp-config`. CRITICAL: stdout is the protocol channel — we MUST NOT
// write to stdout from this file or anything it imports. All logging goes to
// stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebClient } from '@slack/web-api';
import { SLACK_MCP_SERVER_NAME } from '../slack-mcp-config.js';
import {
  getChannelHistory,
  getChannelHistoryInputShape,
  SLACK_GET_CHANNEL_HISTORY_TOOL_NAME,
} from './tools/get-channel-history.js';
import {
  getUserInfo,
  getUserInfoInputShape,
  SLACK_GET_USER_INFO_TOOL_NAME,
} from './tools/get-user-info.js';

const SERVER_VERSION = '0.0.0';

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (token === undefined || token.length === 0) {
    process.stderr.write(`${SLACK_MCP_SERVER_NAME}: SLACK_BOT_TOKEN env var is required\n`);
    process.exit(1);
  }

  const client = new WebClient(token);
  const server = new McpServer(
    { name: SLACK_MCP_SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Tools for reading Slack channel context. `slack_get_channel_history` returns recent messages with bot_id preserved (other bots distinguishable from humans). `slack_get_user_info` resolves a user ID to a display name so the agent can refer to humans by name in its replies.',
    },
  );

  server.registerTool(
    SLACK_GET_CHANNEL_HISTORY_TOOL_NAME,
    {
      description:
        'Read recent messages from a Slack channel the bot is a member of. Returns most recent first. Bot-authored messages are included; their bot_id field is preserved so the agent can distinguish them from human messages.',
      inputSchema: getChannelHistoryInputShape,
    },
    async (args) => getChannelHistory(client, args),
  );

  server.registerTool(
    SLACK_GET_USER_INFO_TOOL_NAME,
    {
      description:
        'Look up a Slack user by ID. Returns id, name, optional real_name / display_name, and is_bot. Use after `slack_get_channel_history` returns a `user` field that needs resolution to a human-readable name.',
      inputSchema: getUserInfoInputShape,
    },
    async (args) => getUserInfo(client, args),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SLACK_MCP_SERVER_NAME} v${SERVER_VERSION} running on stdio\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${SLACK_MCP_SERVER_NAME}: fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
