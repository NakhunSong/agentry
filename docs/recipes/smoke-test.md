# Smoke test — Slack thread → Claude reply → DB

This recipe walks the end-to-end MVP slice (issue #21): mention the bot
in a Slack thread, get a Claude reply, and confirm both turns landed in
Postgres.

The recipe targets a developer machine. Production deployment lands in
Phase 5; the `docker-compose.yml` here is dev-only.

## Prerequisites

| Tool                | Why                                                  |
| ------------------- | ---------------------------------------------------- |
| Docker + Compose v2 | Local Postgres 16 + pgvector                         |
| Node 22+            | `engines` floor; tested on 22 and 24                 |
| pnpm 10.33.x        | Pinned via root `packageManager`                     |
| Claude CLI          | `claude` on PATH, logged in (Anthropic subscription) |
| ngrok (or similar)  | Slack must reach the local Bolt receiver             |
| A Slack workspace   | You need admin rights to install a bot               |
| A Voyage account    | `voyage-3.5` is the default embedding model          |

## 1. Slack app

Create a new app from manifest in your workspace:
`https://api.slack.com/apps?new_app=1` → **From a manifest** → paste:

```yaml
display_information:
  name: agentry-smoke
features:
  bot_user:
    display_name: agentry-smoke
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
      - channels:read
      - groups:read
      - users:read
settings:
  event_subscriptions:
    request_url: https://REPLACE_WITH_NGROK_URL.ngrok.io/slack/events
    bot_events:
      - app_mention
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

After **Install to Workspace**:

- Copy **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
- Copy **Signing Secret** (Basic Information → App Credentials) → `SLACK_SIGNING_SECRET`

Invite the bot to a public channel: `/invite @agentry-smoke`.

## 2. Build the workspace

The migrator (`apps/cli`) and the server (`apps/server`) both run from
the host — neither has a Dockerfile yet (Phase 5 territory). Build once
upfront; later steps reuse the same `dist/`.

```bash
pnpm install
pnpm build
```

## 3. Bring up Postgres

```bash
docker compose up -d
docker compose logs -f postgres   # optional: wait for "ready to accept connections"
```

The compose file pins `pgvector/pgvector:pg16`; the `vector` extension
is created by the migration, not the image entrypoint.

## 4. Apply migrations

```bash
# Match the dim VoyageEmbeddingProvider produces (default voyage-3.5 → 1024)
EMBEDDING_DIM=1024 \
POSTGRES_URL=postgres://agentry:agentry@localhost:5432/agentry \
node apps/cli/dist/main.js migrate
```

Run via the host CLI rather than `docker compose run psql -f …`: the
migrator records a `_agentry_migrations` row per applied file so
re-running is a no-op, and that bookkeeping is in workspace TypeScript,
not the SQL file itself.

Expected output:

```
applied 0001_init.sql
migrate done — applied: 1, skipped: 0
```

Verify the schema:

```bash
docker compose exec -T postgres psql -U agentry -d agentry -c '\dt'
# Should list: _agentry_migrations, knowledge_items, sessions, source_refs,
# tenants, turns
```

## 5. Configure secrets

```bash
cp .env.example .env
# Edit .env:
#   SLACK_BOT_TOKEN=xoxb-…           (from §1)
#   SLACK_SIGNING_SECRET=…            (from §1)
#   POSTGRES_URL=postgres://agentry:agentry@localhost:5432/agentry
#   VOYAGE_API_KEY=pa-…               (from voyageai.com)
```

## 6. Start the tunnel

```bash
ngrok http 3001
```

Copy the `https://…ngrok.io` URL into the Slack app's **Event
Subscriptions → Request URL** as `<URL>/slack/events`. Slack will issue
a verification handshake the moment you save; if the server isn't
running yet, save in step 8 instead.

## 7. (Optional) Run the unit suite

Sanity-check the build before booting the server:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm depcheck
```

## 8. Boot the server

```bash
# Node `--env-file` does NOT override variables already exported in the
# parent shell. If a previous session exported these, .env is silently
# shadowed and the server boots with stale values.
unset SLACK_BOT_TOKEN SLACK_SIGNING_SECRET POSTGRES_URL VOYAGE_API_KEY

node --env-file=.env apps/server/dist/main.js
```

Expected log line:

```
{"level":30,"msg":"agentry server listening","port":3000}
```

The Bolt receiver runs on `SLACK_PORT` (default 3001) — the port ngrok
forwards to. The Hono `/health` endpoint runs on `PORT` (default 3000).

`curl http://localhost:3000/health` should return:

```json
{
  "status": "ok",
  "adapters": { … },
  "inboundChannels": ["slack"]
}
```

## 9. Trigger a mention

In the channel where the bot was invited:

```
@agentry-smoke what's 2 + 2?
```

Within a few seconds you should see a thread reply from the bot.

## 10. Verify the DB

```bash
docker compose exec -T postgres psql -U agentry -d agentry <<'SQL'
SELECT id, channel_kind, channel_native_ref, status
  FROM sessions
  ORDER BY started_at DESC
  LIMIT 1;

SELECT t.seq_no, t.author_role, LEFT(t.content_text, 60) AS preview
  FROM turns t
  JOIN sessions s ON s.id = t.session_id
  ORDER BY t.seq_no DESC
  LIMIT 5;
SQL
```

DoD met when:

- One row in `sessions` with `channel_kind='slack'` and a
  `slack:<channel>:<thread_ts>` ref
- At least two rows in `turns`: `author_role='user'` (the mention) +
  `author_role='agent'` (the reply)

## Troubleshooting

| Symptom                                                   | Cause / fix                                                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SecretsValidationError` on startup                       | A required `.env` key is missing or malformed. The error names every offending key.                                                                                        |
| `missing required scopes`                                 | Reinstall the Slack app — the manifest scope set grew across `#18` PR2 (`*:history`) and `#26` PR2 (`channels:read` / `groups:read` / `users:read`); existing installs must re-grant.       |
| Slack times out / redelivers events                       | Backfill on the inbound hot path can blow the 3s ack budget on large threads (see issue #63). Reduce thread size for the smoke test, or move backfill offline (followup).  |
| `conversations.replies failed: channel_not_found`         | The bot isn't a member of the channel. `/invite @agentry-smoke` first.                                                                                                     |
| `vector(1024) does not match embedding dimension N`       | The VoyageEmbeddingProvider model returned a different dim than the column. Re-run migrate with `EMBEDDING_DIM=N` after dropping the DB volume (`docker compose down -v`). |
| `claude: command not found` from the `ClaudeCliAgentRunner` | `claude` must be on the same PATH the server inherits. Verify with `which claude`.                                                                                         |
| `ECONNREFUSED 127.0.0.1:5432`                             | Postgres container isn't running or isn't healthy. `docker compose ps` and `docker compose logs postgres`.                                                                 |

## Cleanup

```bash
# Stop server: Ctrl-C
# Stop tunnel: Ctrl-C in the ngrok pane
docker compose down -v   # -v wipes the data volume; drop -v to keep state
```
