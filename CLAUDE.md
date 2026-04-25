# agentry — Project Instructions for Claude Code

## Overview

Pluggable, multi-channel Claude agent framework. Users fork this repo, configure
their channels and knowledge sources, and deploy via Docker. The framework handles
session management, episodic→semantic memory distillation, and the agent runtime.

## Status

**Phase 3 build started.** Phase 1 (architecture) and Phase 2 (KnowledgeStore design)
complete. See `ARCHITECTURE.md` and `docs/design/knowledge-store.md` for the design
contracts that build issues implement against.

## Tech Stack (locked in #29)

- **Runtime**: Node 22+ (`engines: '>=22.0.0'`); Node 24 recommended for new deployments (active LTS)
- **Package manager**: pnpm 10.33.2 (pinned via root `packageManager`)
- **Language**: TypeScript 6.0.3 — strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`
- **Module**: ESM only, `NodeNext` resolution
- **Build**: `tsc --build` with project references
- **Dev runner**: tsx 4.21
- **Test**: vitest 4.1
- **Lint + format**: Biome 2.4 (single tool)
- **Boundary enforcement**: dependency-cruiser 17.3 (regex rules in `.dependency-cruiser.cjs`)
- **Agent runtime**: Claude CLI subprocess (Anthropic subscription-based)
- **Storage**: Postgres + pgvector (Phase 3); graph layer opt-in (Phase 2+)
- **Channels**: Slack first (`slack-bolt`); other channels via adapter pattern
- **Embeddings**: external API — Voyage `voyage-3` is the default
- **Deploy target**: Docker Compose on VPS

## Architectural Principles

- **Ports & Adapters (hexagonal)**. Domain core knows nothing about Slack, Postgres,
  or Claude. Everything external is a port with swappable adapters.
- **Three memory layers** (per the Extract → Cognify → Load pattern):
  - Relational (provenance) — where a fact came from
  - Vector (semantic) — what it means
  - Graph (relational reasoning) — how facts connect (Phase 2+, opt-in)
- **Episodic vs semantic separation**. Raw turns are stored verbatim. Distillation is
  a separate, triggered pipeline that produces `KnowledgeItem`s with provenance back
  to source turns.
- **Procedural memory = `.claude/` + agent-workdir**. The framework ships a default
  agent working directory (CLAUDE.md, skills, rules) that becomes the agent's procedural
  memory. Users override per-deployment.
- **Single-direction sync**. Framework updates push procedural assets to forks.
  User data (episodic + semantic) is never touched by upstream merges.

## Directory Structure

```
packages/
  core/                   # domain + ports + use cases (zero runtime deps)
  testing/                # in-memory adapters for use-case tests
  runtime/                # composition root, config schema (#27)
  adapter-channel-slack/  # to be added in #18
  adapter-runner-claude-cli/  # to be added in #19
  adapter-store-pgvector/ # to be added in #20
  ...                     # other adapters per ARCHITECTURE.md §6
apps/
  server/                 # long-running process (Hono entry point)
  cli/                    # `agentry` CLI binary
seed/
  agent-workdir/          # default procedural memory shipped with framework
docs/
  design/                 # detailed design docs (e.g., knowledge-store.md)
  recipes/                # reference deployments (Phase 3 #22 onwards)
  extending/              # how to add channels / sources / runners
```

Boundary rules (`.dependency-cruiser.cjs`):
- `packages/core` imports nothing else in the workspace
- `packages/adapter-*` and `packages/testing` import only from `core`
- `packages/runtime` imports `core` + zero or more `adapter-*`
- `apps/*` import only from `runtime`

## Conventions

- **Code & config**: English. Korean is acceptable in `docs/` only when content is
  inherently Korean.
- **No backwards-compatibility shims** when refactoring — update all call sites.
  See `~/.claude/CLAUDE.md` Prohibited Patterns section.
- **No `any` in TypeScript**. Define proper types at all boundaries.
- **`import type` is mandatory for type-only imports** (`verbatimModuleSyntax: true`
  is enabled). `import { Foo } from '...'` for values; `import type { Foo } from '...'`
  for types. Mixing causes build errors.
- **ESM-only**: imports use `.js` extensions in source even though files are `.ts`
  (TypeScript respects literal paths under `NodeNext`).
- **Docs are first-class**: ARCHITECTURE.md, design docs in `docs/design/`,
  extension guides in `docs/extending/`. See `~/.claude/rules/documentation.md`.

## Commands

```bash
pnpm install         # install all workspace deps
pnpm build           # tsc --build across all packages
pnpm typecheck       # tsc --build --noEmit (fast)
pnpm lint            # biome check .
pnpm format          # biome format --write .
pnpm test            # vitest run (workspace mode)
pnpm test:watch      # vitest watch
pnpm depcheck        # dependency-cruiser layer rule enforcement
```

Per-package: `pnpm --filter @agentry/<pkg> <script>`.

## Workflow

Follow `~/.claude/rules/agentic-thinking.md`:
Plan → Self-Review (advisor) → User Approval → Implement → /simplify → Self-Review → Test.

For multi-file changes, use parallel review subagents. For PR-worthy work, use
worktrees per `~/.claude/rules/git-workflow.md`.

## References

- `nakbot-agent` (sibling project) — Original Nakbot, the inspiration for this
  abstraction; lives at `/Users/nakhunsong/dev/nakhun/nakbot-agent`
