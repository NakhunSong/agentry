# For onboarding

A guided tour for developers (or AI agents) joining the agentry codebase. This is the "what's actually going on here, and why" companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md), which is the formal design document.

If you read only one section: **Read "The hexagon and its tax"** below. Everything else flows from that decision.

## Twenty-thousand-foot view

agentry is a framework for building **personal Claude bots**. Not a SaaS, not a hosted product — a fork-friendly skeleton you clone, customize, and run on your own VPS. Today the bot lives in Slack; tomorrow it lives wherever you teach it to listen. The framework's job is everything *between* "a message arrived somewhere" and "the agent replied with relevant context": session bootstrap, memory persistence, retrieval, prompt assembly, runner orchestration, and reply delivery.

The shipped MVP slice (Phase 3): post a Slack mention, get a Claude reply, both turns persist in pgvector, and the next mention gets context-aware retrieval. That's what's running.

## The hexagon and its tax

The single most important architectural decision: **agentry is a hexagonal (ports & adapters) codebase**. The domain core lives in `packages/core` and knows nothing — *literally nothing* — about Slack, Postgres, Anthropic, or anything else outside its own type universe. Concrete services plug in via "ports" (TypeScript interfaces) implemented by "adapters" (concrete classes).

The benefit: when GPT-5 ships, swapping the agent runner is a constructor change. When Discord becomes a priority, the channel adapter is a new package — no other code knows the difference. When you decide pgvector isn't enough, you write `QdrantKnowledgeStore` against the same port and the use cases never notice.

The tax: **`packages/core` cannot import anything else in the workspace**. Not a util from `runtime`, not a fake from `testing`, nothing. `dependency-cruiser` enforces this in CI. Adapters can only import from `core`; testing can only import from `core`; runtime can import core + adapters. Apps can do anything because they're the composition root.

This sounds tidy on paper. In practice it means you'll occasionally find yourself duplicating a tiny utility (a `silentLogger`, a `Deferred<T>`) in multiple places because the canonical home is forbidden by the boundary rules. The right reaction is **don't fight depcruiser** — file a "promote to core when there are 3+ drivers" followup and move on. The first three times the rule felt annoying; the first time someone tried to import a `pg` Pool into `core` and depcruiser said no, the rule paid for itself forever.

## Three kinds of memory

Conceptually, agentry distinguishes three memory layers (per Cognee's Extract → Cognify → Load pattern):

1. **Episodic** — raw turns. Every user message and agent reply, verbatim. Lives in Postgres `turns` table. Source of truth for "what was actually said." A 30-message thread is 30 rows.
2. **Semantic** — distilled `KnowledgeItem`s. Phase 2+ pipeline consumes recent turns and produces durable facts ("the user prefers TS over JS"; "the customer's account ID is X"). Stored in pgvector. Retrieved by similarity per turn.
3. **Procedural** — the agent's own instructions. Today this is just `seed/agent-workdir/CLAUDE.md`. As your fork grows, you'll add `seed/agent-workdir/.claude/skills/` and `seed/agent-workdir/.claude/rules/` — the Claude CLI subprocess inherits whatever you put there the same way *you* inherit `~/.claude/CLAUDE.md` when you run Claude Code.

The three live in different storage tiers (DB, DB, git). Distinguishing them matters because **upstream framework updates push procedural changes downstream to forks, but never touch episodic or semantic data**. That's the "single-direction sync" promise: when you `git pull upstream main`, you get the latest framework code and the latest default `CLAUDE.md`, but your bot doesn't forget who its users are.

## The 3-second ack budget story

This is the single most pedagogically useful incident in the codebase. If you're going to extend a channel adapter, internalize this story.

**Setup**: Slack's Events API requires the bot to acknowledge a webhook within 3 seconds. Miss the budget and Slack assumes you're dead, redelivers the event, and your bot processes it twice. The framework's `HandleIncomingMessage` use case is designed around this — `findOrCreate(session)` (one DB roundtrip) + `JobRunner.enqueue(job)` (no I/O), then return. The agent's actual run happens inside the queued job, which can take 30 seconds or more.

**The trap**: when shipping #18 (Slack adapter), the obvious place to do thread-history backfill was inside the `app_mention` handler — fetch `conversations.replies(thread_ts)`, map to synthetic events, forward them through the handler before the live event. It worked! The bot saw the full thread context. Then someone mentioned the bot in a thread with 40 prior messages, the backfill took 1.5 seconds, the agent run started normally, and Slack hit the 3-second timeout (because ack happens at *return-from-handler*, not at *first I/O*). Slack redelivered. The bot replied twice.

**The fix wasn't a `Promise.race`** that would have shipped a week earlier. The structural fix was to define a new port — `SessionFirstTouch` — that runs *inside the queued job*, off the ack path entirely. Now `app_mention` does only `mapAppMentionToIncomingEvent` + `await handler(live)`; backfill is the first step of the queued job, and the framework swallows backfill failures so a transient Slack rate-limit can't drop the user's mention.

**The measured payoff**: hot path (already-backfilled session) returns in **6ms** with zero Slack API calls. Cold path stays at ~378ms (one `conversations.replies`). And the architecture is now channel-agnostic — Discord's eventual `DiscordHistoryBackfiller` plugs into the same port.

The lesson, made concrete: **structural fixes beat timing prayers**. Whenever you find yourself reaching for `Promise.race`, `setTimeout`, or "let's just make it faster," ask if the work belongs on the path you're trying to speed up. Often it doesn't.

## Concurrency in 2 layers

Two concurrency primitives, no more:

1. **Process-level**: `JobRunner` per-key FIFO. Same `key` (typically `sessionId`) → strict FIFO chain; different keys → parallel. Implemented in-memory as a `Map<string, Promise<void>>` of last-promise-per-key. When you enqueue, you `previous.then(() => job)` and store the new tail.
2. **Cross-process**: nothing yet. The MVP runs on a single VPS, single process. The architecture earmarks `pg-boss` as the production swap (issue #28) when horizontal scaling, restart durability, or operational visibility becomes a need. Until then, in-memory wins on simplicity.

This is intentional minimalism. BullMQ + Redis would have been the "responsible enterprise" choice, but it would have added a container, an operational surface, and a serialization boundary — for a single-VPS bot that doesn't need any of those. The right time to add the queue is when the cost of *not* having it actually appears.

The per-key FIFO contract is load-bearing for `SessionFirstTouch` correctness — see the inline comment in `packages/core/src/app/handle-incoming-message.ts`. Don't break it without understanding what depends on it.

## The closure check + findByRef choreography

When two mentions arrive in the same Slack thread within milliseconds, the use case enqueues two jobs with the same `key`. The first job's `SessionFirstTouch` runs, fetches history, sets `session.metadata.slackBackfilled = true`. The second job's `SessionFirstTouch` should see "already done" and skip the Slack API.

Per-key FIFO makes single-process correctness trivial — job 2 can't start until job 1 finishes. But what if job 2 was enqueued by `handleIncomingMessage` while job 1 was running? The closure-captured `session` in job 2 still has `metadata.slackBackfilled` undefined (the framework called `findOrCreate` before enqueue, when the flag wasn't set yet). The closure is stale.

Two layers of defense:

1. **Closure check** (cheap): `if (session.metadata[SLACK_BACKFILLED_METADATA_KEY] === true) return [];`. When the flag was already true at `findOrCreate` time (i.e., a third mention after the second already finished), you skip without any I/O.
2. **`findByRef` re-check** (one DB roundtrip): when the closure says "not done," re-read fresh. If a sibling has flipped the flag in the meantime, return `[]` without `setMetadata` and without the Slack API call.

The race test in `packages/testing/src/app/handle-incoming-message-first-touch.test.ts` exercises exactly this — pause job 1's first-touch, enqueue mention 2, release job 1, drain queue, assert "slow path" called exactly once. The race is genuinely impossible to single-process-race when you understand the FIFO + closure interaction; the `findByRef` is **multi-process insurance** for the day a `pg-boss` adapter ships.

## The PR decomposition style

You'll notice the git history is full of small PRs. PR #70 lifted a `SessionStore.findByRef` port. PR #71 used that port to architecturally relocate Slack backfill. Combined into one PR they would have been 800+ lines of mixed concerns; split into two, each had one architectural decision and a tight reviewer-loop.

The pattern: **port lift first**, **adapter integration second**. Lifting a port is a "shape" change reviewers can think about in isolation (does the contract make sense? is the input shape minimal?). Adapter integration is a "use" change (does this honor the contract? are the failure semantics right?). Doing them in one PR forces reviewers to evaluate both at once with no clear hand-off.

The exception: when a change is genuinely small (< 200 lines) or when the port and the adapter are co-evolving and splitting would require throwaway scaffolding. Use judgment.

## Recipes catch what tests can't

The smoke-test recipe (`docs/recipes/smoke-test.md`) is the single most underrated artifact in the repo. Every Phase 3 PR ran the recipe live before merge — and every Phase 3 PR caught at least one bug that unit tests had missed. Some examples:

- **`docker compose exec` heredoc** needs `-T` to skip TTY allocation, or the `<<'SQL'` blob gets mangled. Tests don't run docker; the recipe author hit it on attempt #2.
- **`node --env-file=.env`** does *not* override variables already exported in the parent shell. Tests don't simulate shell exports; the recipe author hit a 30-minute "why isn't my new SLACK_BOT_TOKEN being read" before noticing the old one was still in the shell. Fixed by adding env-shadow detection at boot (`apps/server/src/env-shadow-check.ts`).
- **Slack manifest reinstall** is required after every scope addition. The first time `SLACK_REQUIRED_SCOPES` grew (`channels:history`, `groups:history` for thread reads), the bot kept saying "missing required scopes" until the operator reinstalled the app. Documented in the recipe and in the `SLACK_REQUIRED_SCOPES` comment.

The lesson: **mocks are perfect substitutes for the things you remembered to mock**. The shell, the OS, the network, the third-party API's actual response shape — those don't get mocked. Run the recipe on a clean machine before declaring a feature shipped. Every time.

## The bot_id filter inversion

This is the most subtle gotcha in the Slack adapter, and worth knowing before you touch anything Slack-related.

`SlackHistoryBackfiller` (the `SessionFirstTouch` impl) reads `conversations.replies` and **drops messages with `bot_id` set**. Reasoning: those are the bot's own past replies. The use case records every synthetic event as `authorRole: 'user'` — recording bot replies as "user said" would corrupt the agent's context.

The runtime MCP tool `slack_get_channel_history` (the one the agent calls mid-conversation) **preserves messages with `bot_id` set**. Reasoning: the agent might need to read another bot's QA reports to answer a question about them. Different code path, opposite filtering decision.

If you change one filter, **think hard about whether you should change the other**. They look related but they aren't — they're answering different questions. Documented in the issue #26 body and in inline comments at both filter sites.

## Configuration is in three tiers, not one

The `docs/extending/configuration.md` table is short but important:

| Tier | Examples | Where it lives |
|---|---|---|
| **Secret** | `SLACK_BOT_TOKEN`, `POSTGRES_URL`, `VOYAGE_API_KEY` | Process env. Validated by `SecretsSchema` (zod). Never in git. |
| **Configuration** | Channel allowlists, idle timeouts, embedding model | `agentry.config.ts` (TypeScript). Committed to the fork. |
| **Runtime-resolved** | Slack channel IDs, user names, message timestamps | Not pre-configured. The agent resolves at run time via tools. |

The most common mistake: putting a runtime-resolved value into config. If you find yourself adding `SLACK_DEFAULT_CHANNEL_ID` to `.env`, stop and ask: shouldn't the agent know what channel it's in from the event itself? (Yes, it should. The `SessionPolicy.toAgentContext` hook gives it that.)

## Where to start reading

Suggested tour for a new contributor:

1. `ARCHITECTURE.md` — the formal contract surface. Skim §3 (domain model) and §4 (ports), read §5 (use cases) carefully.
2. `packages/core/src/ports/index.ts` — the actual port shapes in code.
3. `packages/core/src/app/handle-incoming-message.ts` — the entire MVP use case in one file. Read the comments; they cite the contracts they depend on.
4. `packages/adapter-channel-slack/src/slack-history-backfiller.ts` — the `SessionFirstTouch` reference impl. The closure-vs-findByRef story comes alive here.
5. `docs/recipes/smoke-test.md` — what an operator actually does to bring this up.
6. `docs/extending/*` — when you're ready to write your own adapter.
7. `CHANGELOG.md` — what's shipped.

Skip on first read: the test files (they assume you know the contracts), `packages/runtime/src/compose.ts` (the wiring is mechanical once you know the ports), `packages/adapter-store-pgvector/src/migrate/0001_init.sql` (the schema is what it is — read when you need to change it).

## Lessons that didn't fit elsewhere

- **`useLiteralKeys` lint infos** in `packages/core/src/app/handle-incoming-message.ts:124,181` are pre-existing (commit ae9b6412, 2026-04-26). Biome wants `obj.literal` not `obj['literal']`. Cosmetic. File a cleanup PR if scope allows; don't block other work on it.
- **Port 3000 collision**: if you're a developer who also runs Next.js dev servers locally, agentry's Hono `/health` will collide. Use `PORT=3010` to avoid the dance. Slack Bolt's `SLACK_PORT=3001` is independent.
- **`process.once('exit')` does not fire on signal-kill**. The Claude CLI runner's MCP-config tempfile cleanup needed explicit `SIGINT` and `SIGTERM` listeners after this was discovered live. If you write any process-lifetime cleanup, register all three.
- **GitHub auto-close keywords are regex-y, not parse-y**. "Does not close #N" still auto-closes #N because the regex matches the substring. Reserve close-keywords (`closes`, `fixes`, `resolves`) for the *final* PR in a series; PRs A/B/C of N should reference the issue with `(see #N)` or similar.

## When in doubt

- **Architecture question?** Read `ARCHITECTURE.md` §1 (Goals & Non-Goals) before proposing an addition.
- **"Should this be a port?"** Three drivers (three concrete adapters that would implement it). Until then, it's a private function in one adapter.
- **"Should this be in core?"** Does the domain need it (yes → core), or does an adapter need it (yes → that adapter)? Shared utilities go to core only when 2+ adapters need them.
- **Stuck on a workflow rule?** Check `~/.claude/rules/` (the maintainer's harness rules) and project `CLAUDE.md` (project conventions). If they conflict, project `CLAUDE.md` wins.

Welcome aboard.
