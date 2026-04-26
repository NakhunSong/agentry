import type { AgentEvent, AgentRunInput, AgentRunner } from '@agentry/core';

export class RecordingAgentRunner implements AgentRunner {
  readonly kind = 'recording';
  readonly inputs: AgentRunInput[] = [];

  constructor(private readonly events: readonly AgentEvent[] = []) {}

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    this.inputs.push(input);
    for (const ev of this.events) yield ev;
  }
}
