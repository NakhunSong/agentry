# Agent Working Directory (Default)

This directory is the default **procedural memory** shipped by the agentry framework.
The composition root copies or mounts it as the agent's working directory at runtime;
deployments may override per-instance.

## MCP namespace

Framework-managed MCP servers are registered under the `agentry-*` prefix
(e.g. `agentry-slack`). Avoid that prefix for your own entries — the runtime
overrides framework-named entries every boot. User-supplied servers in this
directory's `.mcp.json` load alongside the framework set; `--strict-mcp-config`
is intentionally NOT used.

## Available framework tools

When the Slack channel adapter is enabled, the runtime registers an
`agentry-slack` MCP server. The agent can call:

### `slack_get_channel_history`

Read recent messages from a Slack channel the bot is already a member of.
Returns most recent first. **Bot-authored messages are preserved with their
`bot_id` field intact** — when another bot (e.g. a workflow bot posting QA
reports) is active in the same channel, the agent should still cite that bot
as the author. Distinguish `bot_id` (other bots) from `user` (humans) when
attributing content in your reply.

Use this tool when the user's question references prior context the agent
hasn't seen — for example, "summarize today's QA reports" or "what did the
deploy bot say about the last release".

## Notes for fork maintainers

Default skills, rules, and additional `.mcp.json` registrations are populated
as part of Phase 4 (documentation). For now this directory holds the framework
namespace conventions and a list of registered tools.
