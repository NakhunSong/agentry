# agentry

> Pluggable, multi-channel Claude agent framework with episodic→semantic memory distillation.

`agentry` is a fork-friendly framework for building your own Claude-powered agent (Slack bot, CLI assistant, custom integration) that learns from conversations over time. Bring your own channel, your own knowledge sources, your own deployment — the framework handles session management, memory distillation, and the agent runtime loop.

## Status

🚧 **In design.** This repository currently holds design notes and references.
Implementation begins after the architecture phase is approved. See [docs/](./docs/)
for reference material and `MEMORY.md` / GitHub issues for current planning state.

## Vision

- **Channel-agnostic**: Slack first, but any input transport plugs in via the `InboundChannel` port (Discord, CLI, HTTP webhook, ...).
- **Claude-subscription based**: Runs `claude` CLI under the hood — no separate API key juggling.
- **Memory that learns**: Sessions are stored as raw episodic memory, then periodically distilled into semantic knowledge with provenance tracking, following an Extract → Cognify → Load pattern.
- **Single-container deploy**: One `docker compose up` on a VPS gets you running. Postgres + pgvector for storage; graph layer is opt-in.
- **Single-direction sync**: Framework updates flow downstream to your fork; your data stays yours.

## Roadmap

| Phase | Scope |
|---|---|
| 1 | Architecture design (ports & adapters) |
| 2 | KnowledgeStore + distillation pipeline design |
| 3 | MVP slice — Slack adapter + claude CLI runner + pgvector |
| 4 | Documentation & extension guides |
| 5 | Docker compose & VPS deployment story |

Track progress in the [project board](https://github.com/users/NakhunSong/projects).

## License

MIT — see [LICENSE](./LICENSE).
