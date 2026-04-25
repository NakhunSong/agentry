# agentry — Project Instructions for Claude Code

## Overview

Pluggable, multi-channel Claude agent framework. Users fork this repo, configure
their channels and knowledge sources, and deploy via Docker. The framework handles
session management, episodic→semantic memory distillation, and the agent runtime.

## Status

**Design phase.** No implementation code yet. Current focus is architectural design
across 5 phases (see README roadmap and GitHub issues).

## Tech Stack (planned)

- **Language**: TypeScript (Node.js, ESM)
- **Agent runtime**: Claude CLI subprocess (Anthropic subscription-based) — `AgentRunner`
  port abstracts this so the Agent SDK can swap in later
- **Storage**: Postgres + pgvector (single container, Phase 1). Graph layer (Apache AGE
  or external) is opt-in for Phase 2
- **Channels**: Slack first (slack-bolt or slack-edge); other channels via adapter pattern
- **Embeddings**: External API (Voyage / OpenAI / Cohere) — no local embedding models
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

## Directory Structure (planned, Phase 3+)

```
src/
  domain/        # Channel-agnostic entities (Session, Turn, KnowledgeItem)
  ports/         # Interface definitions
  adapters/
    channels/    # slack/, discord/, cli/, http/
    storage/     # pgvector/, ...
    agent/       # claude_cli/, ...
    sources/     # github/, web/, ...
  app/           # Use cases
  infra/         # DI, config, migrations
docs/
  ref*.md        # External references (memory architecture)
  recipes/       # Reference deployments (e.g., nakbot-style wiki bot)
  extending/     # How to add channels / sources / runners
seed/
  agent-workdir/ # Default procedural memory shipped with framework
```

## Conventions

- **Code & config**: English. Korean is acceptable in `docs/` only when content is
  inherently Korean.
- **No backwards-compatibility shims** when refactoring — update all call sites.
  See `~/.claude/CLAUDE.md` Prohibited Patterns section.
- **No `any` in TypeScript**. Define proper types at all boundaries.
- **Docs are first-class**: ARCHITECTURE.md, README, extension guides. See
  `~/.claude/rules/documentation.md`.

## Commands

To be defined in Phase 3 (build phase). Will include:
- `pnpm install` / `pnpm dev` / `pnpm build` / `pnpm test`
- `pnpm lint` / `pnpm typecheck`
- `docker compose up` for the full stack

## Workflow

Follow `~/.claude/rules/agentic-thinking.md`:
Plan → Self-Review (advisor) → User Approval → Implement → /simplify → Self-Review → Test.

For multi-file changes, use parallel review subagents. For PR-worthy work, use
worktrees per `~/.claude/rules/git-workflow.md`.

## References

- `nakbot-agent` (sibling project) — Original Nakbot, the inspiration for this
  abstraction; lives at `/Users/nakhunsong/dev/nakhun/nakbot-agent`
