import { z } from 'zod';

const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export const AgentryConfigSchema = z.object({
  agentWorkdir: z.string().min(1, 'agentWorkdir must not be empty'),
  logging: z
    .object({
      level: LogLevelSchema.default('info'),
    })
    .default({ level: 'info' }),
});

export type AgentryConfigInput = z.input<typeof AgentryConfigSchema>;
export type AgentryConfig = z.output<typeof AgentryConfigSchema>;

export function defineConfig(config: AgentryConfigInput): AgentryConfig {
  return AgentryConfigSchema.parse(config);
}
