import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolves to `packages/adapter-channel-slack/dist/mcp/server.js`.
// Skipped when the package hasn't been built — local dev runs vitest before
// `pnpm build`. CI runs build first.
const here = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(here, '..', '..', 'dist', 'mcp', 'server.js');
const built = existsSync(SERVER_PATH);

describe.skipIf(!built)('mcp/server.js (built)', () => {
  // Stdout is the MCP protocol channel. Even one accidental `console.log`
  // from our code (or any imported module) would break the JSON-RPC framing
  // on the Claude CLI side. The fail-fast SLACK_BOT_TOKEN check exits BEFORE
  // any transport opens, so stdout MUST be empty in that path.
  it('writes nothing to stdout when SLACK_BOT_TOKEN is missing', () => {
    const result = spawnSync(process.execPath, [SERVER_PATH], {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('SLACK_BOT_TOKEN');
  });
});
