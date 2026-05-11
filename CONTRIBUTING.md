# Contributing

agentry is fork-friendly by design. You're expected to fork, customize, and deploy — not install from npm and configure via CLI flags. This guide covers two flows:

1. **Keeping your fork in sync** with upstream framework updates without losing your customizations.
2. **Upstreaming improvements** back to the framework.

## The fork model

```
upstream (NakhunSong/agentry)
   │
   │ framework code, ports, adapters, default seed
   │ pushed downstream via fast-forward merge
   ▼
your fork (you/agentry-mybot)
   │
   │ your channel config, agent-workdir/CLAUDE.md, your .env, your DB
   │ stays in your fork; never touched by upstream
   ▼
deploy (VPS, container, etc.)
```

Two layers, conceptually:

| Layer | Examples | Owner |
|---|---|---|
| **Framework** | `packages/core`, `packages/adapter-*`, `packages/runtime`, `apps/*`, default `seed/agent-workdir/CLAUDE.md`, `docs/`, `ARCHITECTURE.md`, root configs | Upstream — pull updates without thinking |
| **Your data** | `.env`, your customizations of `seed/agent-workdir/`, anything in `data/` your bot writes, Postgres content | Your fork — upstream never touches |

The split exists in code: `seed/agent-workdir/` is procedural memory (instructions, skills, rules) and ships shared. Episodic + semantic memory lives in your Postgres database, which the framework manages but never serializes into git.

## Keeping your fork in sync

```bash
# One-time setup: add upstream
git remote add upstream https://github.com/NakhunSong/agentry.git

# Each time you want updates
git fetch upstream
git checkout main
git merge upstream/main
```

**Safe to fast-forward**: framework code, default rules, docs, configs (`tsconfig.json`, `package.json`, `biome.json`, `.dependency-cruiser.cjs`).

**Will conflict on customization** (resolve manually):

- `seed/agent-workdir/CLAUDE.md` — if you replaced the default with your bot's persona, reconcile manually. The recommended pattern is to keep the framework default and overlay your additions in a separate file your CLAUDE.md references via `@./my-overlay.md`.
- `.env.example` — adopt new keys as upstream adds them; your `.env` (gitignored) stays.
- `apps/server/src/main.ts` — if you've extended `buildChannels` for your own adapter, re-apply the change after the merge. Keep your adapter in `packages/adapter-channel-mybot/` so the diff is cleaner.

**Never touched by upstream**: anything outside the framework layer above. Your `.env` is gitignored. Your DB is in a Postgres container or external service. Your branch-specific customizations live in branches you control.

## Upstreaming improvements

Bugs, port-contract clarifications, new adapters that other forks would want, doc fixes — open a PR upstream.

### Before opening a PR

Run the full local pipeline:

```bash
pnpm typecheck    # tsc --build
pnpm lint         # biome check
pnpm test         # vitest run (workspace mode)
pnpm depcheck     # dependency-cruiser layer enforcement
```

All must pass cleanly. The depcheck is non-negotiable — boundary violations block the merge.

### What lands easily

- New port or adapter following the patterns in `docs/extending/*` (channel, runner, embedding, store).
- Bug fixes with a regression test (vitest) reproducing the failure.
- Doc improvements, especially worked examples in `docs/extending/*`.
- Smoke-test recipe additions (`docs/recipes/`) — alternative deployment patterns, e.g., Kubernetes, Fly.io.

### What needs design discussion first (open an issue)

- Changes to a port signature in `@agentry/core`. Every adapter and every fork's overrides depend on stability here.
- Adding a port. Each new port is a new contract every adapter author has to implement or opt out of.
- Architectural shifts (e.g., promoting `seed/agent-workdir/` into a separate package). Easier to land after consensus than to re-do.

### Commit and PR conventions

Commit message format: `<type>(<scope>): <description>`. Examples from history:

```
feat(core,slack,runtime,server,testing): SessionFirstTouch port + Slack ack-path purification (#63)
fix(runner): SIGTERM tempfile cleanup
docs(extending): channel-adapter guide
```

Scopes are package or area names: `core`, `slack`, `runtime`, `server`, `pgvector`, `testing`, `docs`, `ci`, etc. Multiple comma-separated when a change spans them.

PR descriptions should include:

- **Summary** (1–3 bullets) — what changed.
- **Why** — what driver/issue motivated it.
- **Test plan** — checked boxes for typecheck/lint/test/depcheck plus any live e2e if relevant.
- **Out of scope** — followups intentionally deferred. File new issues for them when a driver appears (don't park them on the PR).

## Workflow conventions

- **One PR per logical change.** Refactors, port lifts, and feature work go in separate PRs even when the diff feels related. Reviewers can hold one model in their head at a time.
- **Squash merge only inside worktrees.** Top-level feature → main merges use regular merge (`--merge`), not squash. Branch deletion is manual, not automated at merge time.
- **No `--no-verify` / `--no-gpg-sign`** unless there's a documented reason. Hooks exist to catch things; bypassing them in code that lands in main is an antipattern.
- **Update CHANGELOG.md** under `## [Unreleased]` for any user-visible change. Internal refactors don't need an entry.
- **Update relevant docs** in the same PR — `ARCHITECTURE.md` for new ports, `docs/extending/*` for guide-relevant changes, `README.md` for env-var or quick-start changes.

## Code style

- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`. The compiler catches most issues; biome catches the rest.
- ESM only. Imports in source use `.js` extensions even though the file is `.ts` (TypeScript respects literal paths under `NodeNext`).
- `import type { Foo }` for type-only imports. Mixing values and types in one import causes build errors.
- No `any`. Define proper types at every boundary.
- No backwards-compatibility shims. Update call sites directly.
- Comments should explain WHY, not WHAT. Well-named identifiers handle the WHAT.

See `CLAUDE.md` for the full convention list and `~/.claude/rules/` for the workflow rules the maintainer follows.

## License

MIT — see [LICENSE](./LICENSE). Contributions are accepted under the same license.
