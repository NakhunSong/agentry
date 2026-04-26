import { describe, expect, it } from 'vitest';
import type { IncomingEvent } from '../domain/channel.js';
import type { InboundChannel } from './inbound-channel.js';

// Compile + runtime smoke. The fake pins the abort-resolves-start contract
// so adapters that ignore the signal won't accidentally satisfy the type
// alone. Concrete adapters land in their own packages.
function buildFake(): InboundChannel {
  return {
    kind: 'fake',
    async start(_handler, signal) {
      return new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

describe('InboundChannel port', () => {
  it('admits a minimal in-memory implementation that resolves on abort', async () => {
    const channel = buildFake();
    expect(channel.kind).toBe('fake');

    const controller = new AbortController();
    let handlerCalls = 0;
    const handler = async (_event: IncomingEvent): Promise<void> => {
      handlerCalls += 1;
    };

    const started = channel.start(handler, controller.signal);
    controller.abort();
    await started;

    // Handler is callable with the contract shape — exercise it once
    // outside the listener to keep the contract type honest without
    // running a real transport.
    await handler({
      channelKind: 'fake',
      channelNativeRef: 'fake:1',
      author: { channelUserId: 'u1' },
      payload: { text: 'hi' },
      threading: {},
      receivedAt: new Date(),
      idempotencyKey: 'k1',
    });
    expect(handlerCalls).toBe(1);
  });

  it('resolves immediately if the signal is already aborted', async () => {
    const channel = buildFake();
    const controller = new AbortController();
    controller.abort();
    await channel.start(async () => {}, controller.signal);
  });
});
