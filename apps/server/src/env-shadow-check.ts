// Detects when shell-exported environment variables shadow values defined in
// the user's .env file. Node's `--env-file=.env` does NOT override variables
// already exported in the parent shell, so a stale shell export silently
// causes the .env value to be ignored. apps/server fails fast on conflict so
// the user sees the issue at boot rather than chasing a wrong-token symptom
// across deployments.
//
// The parser is intentionally minimal — see `EnvShadowParserNote` in the
// thrown error message. Match the 95% case (KEY=VALUE, comments, single /
// double-quoted values, optional `export ` prefix). Anything fancier
// (multi-line quoted values, escape sequences) is beyond scope; the goal is
// to catch the obvious shadow trap, not to perfectly mirror Node's parser.

import { existsSync, readFileSync } from 'node:fs';

export interface EnvShadowConflict {
  readonly key: string;
}

export function detectEnvShadowConflicts(
  envFilePath: string,
  processEnv: NodeJS.ProcessEnv,
): readonly EnvShadowConflict[] {
  if (!existsSync(envFilePath)) return [];
  const text = readFileSync(envFilePath, 'utf8');
  const conflicts: EnvShadowConflict[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eqIdx = stripped.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = stripped.slice(0, eqIdx).trim();
    if (key.length === 0) continue;
    const value = stripQuotes(stripped.slice(eqIdx + 1));
    const shellValue = processEnv[key];
    if (shellValue === undefined) continue;
    if (shellValue !== value) {
      conflicts.push({ key });
    }
  }
  return conflicts;
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function formatEnvShadowError(
  envFilePath: string,
  conflicts: readonly EnvShadowConflict[],
): string {
  const keys = conflicts.map((c) => `  - ${c.key}`).join('\n');
  return [
    `env shadow detected: ${conflicts.length} key(s) differ between shell exports and ${envFilePath}.`,
    'Node `--env-file` does NOT override shell-exported values, so the .env definition is being silently ignored.',
    'Either `unset` the shell exports or align them with .env. Affected keys:',
    keys,
    'This check uses a minimal .env parser; complex syntax (multi-line strings, escape sequences) may be missed.',
  ].join('\n');
}
