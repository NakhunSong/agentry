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

### Adapter-specific secrets *(open question)*

The current `SecretsSchema` is centralized in `packages/runtime`. As more
adapters land, each will want its own keys (e.g., a Discord adapter adding
`DISCORD_BOT_TOKEN`). The extension contract is not yet decided:

- **Option A** — extend the central schema in `runtime` for every adapter.
  Simple, but `runtime` accretes adapter-specific fields.
- **Option B** — each adapter exports its own `loadXxxSecrets()`.
  Keeps boundaries clean, but the composition root juggles N loaders.
- **Option C** — adapters export schema fragments; `runtime` provides a
  builder that merges them at composition time.

This will be settled when the second adapter (issue #18, Slack) lands.
Until then, treat `SecretsSchema` as the single source of truth.

## Configuration (`agentry.config.ts`)

Forks define an `agentry.config.ts` at the repo root and import it from
their server entry point. Use `defineConfig` for type inference plus zod
validation:

```ts
import { defineConfig } from '@agentry/runtime';

export default defineConfig({
  agentWorkdir: process.env.AGENT_WORKDIR ?? './seed/agent-workdir',
  logging: { level: 'info' },
});
```

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
