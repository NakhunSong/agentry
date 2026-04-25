import { describe, expect, it } from 'vitest';
import { defineConfig } from './agentry-config.js';

describe('defineConfig', () => {
  it('applies default logging when omitted', () => {
    const config = defineConfig({ agentWorkdir: '/tmp/agent' });
    expect(config.logging.level).toBe('info');
  });

  it('applies default level when logging is given without level', () => {
    const config = defineConfig({ agentWorkdir: '/tmp/agent', logging: {} });
    expect(config.logging.level).toBe('info');
  });

  it('preserves explicit logging level', () => {
    const config = defineConfig({
      agentWorkdir: '/tmp/agent',
      logging: { level: 'debug' },
    });
    expect(config.logging.level).toBe('debug');
  });

  it('rejects empty agentWorkdir', () => {
    expect(() => defineConfig({ agentWorkdir: '' })).toThrow();
  });

  it('rejects unknown log level', () => {
    expect(() =>
      defineConfig({
        agentWorkdir: '/tmp/agent',
        // @ts-expect-error — testing runtime validation of invalid input
        logging: { level: 'verbose' },
      }),
    ).toThrow();
  });
});
