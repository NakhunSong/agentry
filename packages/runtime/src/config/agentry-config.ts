import { z } from 'zod';

const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

// JobRunner adapter selection. `memory` is the single-process default; `pg-boss`
// swaps in the cross-process adapter (durable, multi-instance — see
// ARCHITECTURE.md §4.8 swap triggers and `docs/extending/job-runner.md`).
const JobRunnerKindSchema = z.enum(['memory', 'pg-boss']);

export const AgentryConfigSchema = z.object({
  agentWorkdir: z.string().min(1, 'agentWorkdir must not be empty'),
  logging: z
    .object({
      level: LogLevelSchema.default('info'),
    })
    .default({ level: 'info' }),
  jobRunner: JobRunnerKindSchema.default('memory'),
});

export type AgentryConfigInput = z.input<typeof AgentryConfigSchema>;
export type AgentryConfig = z.output<typeof AgentryConfigSchema>;

export function defineConfig(config: AgentryConfigInput): AgentryConfig {
  return AgentryConfigSchema.parse(config);
}
