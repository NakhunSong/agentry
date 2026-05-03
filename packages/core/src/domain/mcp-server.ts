// Description of a stdio-transport MCP server an adapter wants registered with
// the agent runtime. The runtime serializes a list of these into the JSON the
// agent runner hands to Claude CLI via `--mcp-config`.
//
// Adapters MUST namespace `name` under `agentry-*` (e.g. `agentry-slack`).
// Names without that prefix are reserved for user-supplied entries discovered
// from the agent workdir's own `.mcp.json`.
export interface McpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
