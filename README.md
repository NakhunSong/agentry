# agentry

> Pluggable, multi-channel Claude agent framework with episodic→semantic memory distillation.

`agentry` is a fork-friendly framework for building your own Claude-powered agent (Slack bot, CLI assistant, custom integration) that learns from conversations over time. Bring your own channel, your own knowledge sources, your own deployment — the framework handles session management, memory distillation, and the agent runtime loop.

## Status

✅ **Phase 3 (MVP slice) shipped.** Slack mention → Claude reply → both turns in pgvector, end-to-end. The hot path returns under 6ms (zero Slack API calls on subsequent mentions in the same thread). See `docs/recipes/smoke-test.md` for a 30-minute walkthrough on a fresh checkout.

📚 **Phase 4 (extension guides) shipped.** This README plus `docs/extending/*` cover everything a fork needs to plug in a new channel, runner, embedding provider, or store.

## Key features

- **Channel-agnostic** — Slack today, Discord / Microsoft Teams / a CLI / a webhook tomorrow. The `InboundChannel` + `OutboundChannel` + `SessionPolicy` ports are the entire contract.
- **Off-ack-path bootstrap** — channel adapters never block the inbound ack budget. `SessionFirstTouch` (channel-agnostic) runs inside the `JobRunner` queue.
- **Claude-subscription based** — runs the `claude` CLI under the hood; no separate API key juggling. Direct-API runner is a constructor swap (see `docs/extending/agent-runner.md`).
- **Three-layer memory** — relational (provenance) + vector (semantic) shipping today; graph (relational reasoning) opt-in in Phase 2+.
- **Single-container deploy** — one `docker compose up` on a VPS. Postgres + pgvector for storage; no separate vector service.
- **Single-direction sync** — framework updates push procedural assets (CLAUDE.md, skills, rules) to forks. User data (sessions, knowledge) is never touched by upstream merges.

## Tech stack

| | |
|---|---|
| Runtime | Node 22+ (24 recommended) |
| Language | TypeScript 6 — strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` |
| Module system | ESM only, `NodeNext` |
| Package manager | pnpm 10.33.2 (pinned via `packageManager`) |
| Test | Vitest 4 |
| Lint + format | Biome 2 (single tool) |
| Boundary enforcement | dependency-cruiser 17 |
| Storage | Postgres 16 + pgvector |
| Embeddings | Voyage `voyage-3.5` (1024-dim) by default |
| Channels | Slack via `slack-bolt` 4 |
| Agent | Anthropic `claude` CLI subprocess |

## Quick start

```bash
pnpm install
pnpm build

# Postgres + pgvector
docker compose up -d

# Schema (idempotent)
EMBEDDING_DIM=1024 \
POSTGRES_URL=postgres://agentry:agentry@localhost:5432/agentry \
node apps/cli/dist/main.js migrate

# Server (after configuring .env)
node --env-file=.env apps/server/dist/main.js
```

For the Slack-app side (manifest, ngrok tunnel, scope reinstall) plus the verification SQL, see [`docs/recipes/smoke-test.md`](./docs/recipes/smoke-test.md).

## Environment variables

Required at runtime — validated by `SecretsSchema` (zod) at startup; missing keys produce a `SecretsValidationError` listing every offender:

| Key | Shape |
|---|---|
| `SLACK_BOT_TOKEN` | starts with `xoxb-` |
| `SLACK_SIGNING_SECRET` | non-empty |
| `POSTGRES_URL` | URL |
| `VOYAGE_API_KEY` | non-empty |

Optional:

| Key | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Hono `/health` endpoint |
| `SLACK_PORT` | `3001` | Bolt receiver — must match the ngrok forward target |
| `LOG_LEVEL` | `info` | pino log level |
| `AGENT_WORKDIR` | `./seed/agent-workdir` | procedural memory root passed to the agent runner |
| `AGENTRY_ENV_FILE` | `.env` | env-shadow check looks here |

See `docs/extending/configuration.md` for the secret/config/runtime tier separation and how to add new keys when extending the framework.

## Extending

| Want to add | Read |
|---|---|
| Configuration / new secret | [`docs/extending/configuration.md`](./docs/extending/configuration.md) |
| New channel (Discord, Teams, CLI, webhook) | [`docs/extending/channel-adapter.md`](./docs/extending/channel-adapter.md) |
| Different agent runner (direct API, OpenAI, local LLM) | [`docs/extending/agent-runner.md`](./docs/extending/agent-runner.md) |
| Different embedding provider (OpenAI, Cohere, self-host) | [`docs/extending/embedding-provider.md`](./docs/extending/embedding-provider.md) |
| Alternative store (SQLite, DuckDB, Qdrant) | [`docs/extending/store-adapters.md`](./docs/extending/store-adapters.md) |
| Architectural overview | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| Onboarding tour with rationale | [`FOR_ONBOARDING.md`](./FOR_ONBOARDING.md) |

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Architecture design (ports & adapters) | shipped |
| 2 | KnowledgeStore + distillation design | shipped |
| 3 | MVP slice — Slack + claude CLI + pgvector | shipped |
| 4 | Documentation & extension guides | shipped |
| 5 | Docker compose & VPS deploy story | next |

Track current work in the [project board](https://github.com/users/NakhunSong/projects).

## License

MIT — see [LICENSE](./LICENSE).
