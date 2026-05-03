import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig } from '@agentry/core';

export const SLACK_MCP_SERVER_NAME = 'agentry-slack';

export interface SlackMcpServerConfigOptions {
  readonly botToken: string;
}

// Resolves the MCP server entry path via `import.meta.url` so it lands on
// `dist/mcp/server.js` (the sibling of the compiled `dist/slack-mcp-config.js`).
export function slackMcpServerConfig(opts: SlackMcpServerConfigOptions): McpServerConfig {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, 'mcp', 'server.js');
  return {
    name: SLACK_MCP_SERVER_NAME,
    command: process.execPath,
    args: [serverPath],
    env: { SLACK_BOT_TOKEN: opts.botToken },
  };
}
