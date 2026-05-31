# Configuration

agentry separates runtime values into three tiers (per ARCHITECTURE.md §10).
Each value belongs to exactly one tier — mixing them either leaks secrets into
git or scatters configuration across runtime sources.

| Tier | Examples | Where it lives |
|---|---|---|
| **Secret** (never in git) | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `POSTGRES_URL`, `VOYAGE_API_KEY` | Process env. Validated by `SecretsSchema` (zod) at startup. |
| **Configuration** (per-deployment) | Channel allowlists, idle timeouts, embedding model, distillation triggers | `agentry.config.ts` (TypeScript, committed to the fork). Values may interpolate from env. |
| **Runtime-resolved** (dynamic) | Slack channel IDs, user info, message timestamps | Not pre-configured. The agent resolves them via tools at run time (see ARCHITECTURE.md §11). |

## Secrets

`packages/runtime/src/config/secrets.ts` exports `SecretsSchema`, the
`Secrets` type, and `loadSecrets(env?)`. The composition root calls
`loadSecrets()` once at startup; missing or malformed values raise a
`SecretsValidationError` whose message lists every offending key with the
rule that was violated. Secret values themselves are never echoed back —
operators see the key name and the rule, not the bad input.

```ts
import { loadSecrets } from '@agentry/runtime';

const secrets = loadSecrets(); // reads process.env by default
```

### Loading env vars

Use Node 22+'s built-in flag — no `dotenv` dependency required:

```bash
node --env-file=.env apps/server/dist/main.js
```

In Docker Compose, point `env_file:` at the same `.env`. Both are documented
in `.env.example` at the repo root.

### Swapping the secrets source

`loadSecrets(env?)` accepts any `NodeJS.ProcessEnv`-shaped object. To pull
from a secret manager (Vault, AWS Secrets Manager, Doppler, …), populate an
in-memory record and pass it in:

```ts
import { loadSecrets } from '@agentry/runtime';
import { fetchVaultSecrets } from './my-vault-loader.js';

const env = await fetchVaultSecrets();
const secrets = loadSecrets(env);
```

Adapters consume `secrets` through normal property access — they don't know
or care where the values originated.

### Adapter-specific secrets

The pattern that emerged after the Slack + Claude CLI + Voyage + pgvector
adapters all shipped: **`SecretsSchema` stays centralized in `runtime`,
adapters never import `Secrets`**. The composition root reads each value
from the schema and passes plain strings into adapter constructors.

```ts
// packages/runtime/src/config/secrets.ts — single source of truth
export const SecretsSchema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'must start with "xoxb-"'),
  SLACK_SIGNING_SECRET: z.string().min(1, 'must not be empty'),
  POSTGRES_URL: z.url(),
  VOYAGE_API_KEY: z.string().min(1, 'must not be empty'),
});

// apps/server/src/main.ts — composition root maps env → adapter args
const secrets = loadSecrets();
const slackClient = new WebClient(secrets.SLACK_BOT_TOKEN);
const inbound = new SlackInboundChannel({
  botToken: secrets.SLACK_BOT_TOKEN,
  signingSecret: secrets.SLACK_SIGNING_SECRET,
  port: slackPort,
});
```

The benefit beyond schema simplicity: **adapters stay testable without
env**. `SlackInboundChannel`'s constructor takes a plain `botToken` string
— unit tests pass `'xoxb-test'`, no `process.env` stubbing.

**To add a new adapter that needs a secret** (e.g., a Discord adapter):

1. Extend `SecretsSchema` with the new key (with a validator) and update
   `.env.example`.
2. The adapter constructor accepts the value as a plain option — it does
   NOT import `Secrets` or `loadSecrets`.
3. Wire the value at the composition root:
   ```ts
   const inbound = new DiscordInboundChannel({
     botToken: secrets.DISCORD_BOT_TOKEN,
   });
   ```

If the centralized schema gets large enough that contributors fight over
it (≥ 8–10 adapters in active use), revisit by splitting into per-adapter
schema fragments merged at composition time. Until then, the central
schema keeps things obvious — one place to find every required key.

## Configuration (`agentry.config.ts`)

Forks define an `agentry.config.ts` at the repo root and import it from
their server entry point. Use `defineConfig` for type inference plus zod
validation:

```ts
import { defineConfig } from '@agentry/runtime';

export default defineConfig({
  agentWorkdir: process.env.AGENT_WORKDIR ?? './seed/agent-workdir',
  logging: { level: 'info' },
  jobRunner: 'memory', // or 'pg-boss' — see docs/extending/job-runner.md
});
```

Top-level fields:

| Field | Type | Default | Notes |
|---|---|---|---|
| `agentWorkdir` | string (path) | — | Required. Procedural memory + skills the agent runner mounts. |
| `logging.level` | log level | `'info'` | Pino level (`trace`/`debug`/`info`/`warn`/`error`/`fatal`). |
| `jobRunner` | `'memory'` \| `'pg-boss'` | `'memory'` | Cross-process queue — see `docs/extending/job-runner.md` for swap triggers and operational requirements. |

`defineConfig` is an identity function with a runtime parse — no file system
loading, no `tsx` magic. Importers compose the result into the runtime
manually (see `compose.ts`, issue #12).

### Env interpolation

There is no special interpolation syntax. The config file is plain
TypeScript, so `process.env.FOO` works directly:

```ts
defineConfig({
  agentWorkdir: process.env.AGENT_WORKDIR ?? './seed/agent-workdir',
});
```

Group secret-derived values with their consumer (typically an adapter),
not in the global config object.

## Where each value belongs

Before adding a new value, decide its tier by asking:

1. **Would committing this to git be a security incident?** → Secret.
2. **Does this differ between forks/deployments but not between sessions?**
   → Configuration.
3. **Does this depend on something the user just said?**
   → Runtime-resolved (a tool, not config).
