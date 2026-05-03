import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLACK_MCP_SERVER_NAME, slackMcpServerConfig } from './slack-mcp-config.js';

describe('slackMcpServerConfig', () => {
  it('produces a McpServerConfig with the bot token in env', () => {
    const config = slackMcpServerConfig({ botToken: 'xoxb-test-1234' });

    expect(config.name).toBe(SLACK_MCP_SERVER_NAME);
    expect(config.name).toBe('agentry-slack');
    expect(config.command).toBe(process.execPath);
    expect(config.env).toEqual({ SLACK_BOT_TOKEN: 'xoxb-test-1234' });
  });

  it('points args at a sibling mcp/server.js path', () => {
    const config = slackMcpServerConfig({ botToken: 't' });

    expect(config.args).toHaveLength(1);
    const serverPath = config.args?.[0] ?? '';
    expect(serverPath.endsWith(join('mcp', 'server.js'))).toBe(true);
    expect(serverPath).toContain(sep);
  });
});
