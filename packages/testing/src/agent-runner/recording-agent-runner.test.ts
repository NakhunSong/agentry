import type { AgentEvent, AgentRunInput } from '@agentry/core';
import { describe, expect, it } from 'vitest';
import { RecordingAgentRunner } from './recording-agent-runner.js';

const baseInput: AgentRunInput = { sessionId: 's', workdir: '/tmp', prompt: 'hi' };

describe('RecordingAgentRunner', () => {
  it('plays back the scripted events in order', async () => {
    const script: AgentEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'finished', reason: 'complete', usage: { input: 1, output: 1 } },
    ];
    const runner = new RecordingAgentRunner(script);
    const collected: AgentEvent[] = [];
    for await (const ev of runner.run(baseInput)) collected.push(ev);
    expect(collected).toEqual(script);
  });

  it('records each input it is invoked with', async () => {
    const runner = new RecordingAgentRunner();
    for await (const _ of runner.run(baseInput)) void _;
    for await (const _ of runner.run({ ...baseInput, prompt: 'second' })) void _;
    expect(runner.inputs.map((i) => i.prompt)).toEqual(['hi', 'second']);
  });
});
