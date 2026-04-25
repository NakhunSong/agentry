import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@agentry/core';
import { describe, expect, it } from 'vitest';
import { createParserState, parseLine } from './stream-parser.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function loadFixture(name: string): string[] {
  const text = readFileSync(join(fixturesDir, name), 'utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

function parseAll(lines: readonly string[]): AgentEvent[] {
  const state = createParserState();
  return lines.flatMap((line) => parseLine(line, state));
}

describe('parseLine — observed fixtures', () => {
  it('emits text_delta + finished{complete} with usage and resumeKey for a text-only success', () => {
    const events = parseAll(loadFixture('success-text-only.ndjson'));
    expect(events).toEqual([
      { type: 'text_delta', text: '4' },
      {
        type: 'finished',
        reason: 'complete',
        usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 45025 },
        resumeKey: '7adc099b-5d70-4b85-b614-bceb95a7b2e7',
      },
    ]);
  });

  it('emits finished{error} with resumeKey when result.is_error is true', () => {
    const events = parseAll(loadFixture('error.ndjson'));
    expect(events).toEqual([
      {
        type: 'finished',
        reason: 'error',
        usage: { input: 0, output: 0 },
        resumeKey: 'err-session-001',
      },
    ]);
  });
});

describe('parseLine — robustness', () => {
  it('ignores empty lines', () => {
    expect(parseLine('', createParserState())).toEqual([]);
    expect(parseLine('   ', createParserState())).toEqual([]);
  });

  it('ignores malformed JSON', () => {
    expect(parseLine('{not json', createParserState())).toEqual([]);
  });

  it('ignores unknown event types', () => {
    expect(parseLine('{"type":"future_event","data":{}}', createParserState())).toEqual([]);
  });

  it('captures session_id from any event for use by later finished event', () => {
    const state = createParserState();
    parseLine('{"type":"system","subtype":"init","session_id":"abc-123"}', state);
    expect(state.sessionId).toBe('abc-123');
    const events = parseLine(
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1,"output_tokens":2}}',
      state,
    );
    expect(events).toEqual([
      {
        type: 'finished',
        reason: 'complete',
        usage: { input: 1, output: 2 },
        resumeKey: 'abc-123',
      },
    ]);
  });

  it('does not include resumeKey when no session_id was seen', () => {
    const state = createParserState();
    const events = parseLine(
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":1,"output_tokens":2}}',
      state,
    );
    expect(events).toEqual([
      { type: 'finished', reason: 'complete', usage: { input: 1, output: 2 } },
    ]);
  });

  it('emits multiple text_delta events when content has multiple text blocks', () => {
    const state = createParserState();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
      },
    });
    expect(parseLine(line, state)).toEqual([
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
    ]);
  });

  it('maps tool_use blocks to tool_call events (shape unverified)', () => {
    const state = createParserState();
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { path: '/tmp/x' } }],
      },
    });
    expect(parseLine(line, state)).toEqual([
      { type: 'tool_call', name: 'Read', input: { path: '/tmp/x' } },
    ]);
  });
});
