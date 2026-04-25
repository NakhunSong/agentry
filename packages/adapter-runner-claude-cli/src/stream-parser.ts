import type { AgentEvent, TokenUsage } from '@agentry/core';

export interface ParserState {
  sessionId?: string;
}

export function createParserState(): ParserState {
  return {};
}

export function parseLine(line: string, state: ParserState): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];

  if (typeof parsed.session_id === 'string') {
    state.sessionId = parsed.session_id;
  }

  switch (parsed.type) {
    case 'assistant':
      return parseAssistantMessage(parsed);
    case 'result':
      return parseResult(parsed, state);
    default:
      return [];
  }
}

type FinishedEvent = Extract<AgentEvent, { type: 'finished' }>;

export function finishedEvent(
  reason: FinishedEvent['reason'],
  usage: TokenUsage,
  resumeKey?: string,
): FinishedEvent {
  return resumeKey === undefined
    ? { type: 'finished', reason, usage }
    : { type: 'finished', reason, usage, resumeKey };
}

function parseAssistantMessage(event: Record<string, unknown>): AgentEvent[] {
  const message = event.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const events: AgentEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'text_delta', text: block.text });
      continue;
    }
    // Shape unverified — `tool_use` blocks were not present in the captured probe.
    // Mapping follows the Anthropic Messages API contract; revisit when an
    // observed sample is available.
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({ type: 'tool_call', name: block.name, input: block.input ?? {} });
    }
  }
  return events;
}

function parseResult(event: Record<string, unknown>, state: ParserState): AgentEvent[] {
  const usage = parseUsage(event.usage);
  if (event.is_error !== true) {
    return [finishedEvent('complete', usage, state.sessionId)];
  }
  const detail =
    typeof event.api_error_status === 'string'
      ? `claude run reported error: ${event.api_error_status}`
      : 'claude run reported error';
  return [
    { type: 'error', message: detail, recoverable: false },
    finishedEvent('error', usage, state.sessionId),
  ];
}

function parseUsage(raw: unknown): TokenUsage {
  if (!isRecord(raw)) return { input: 0, output: 0 };
  const input = asNumber(raw.input_tokens) ?? 0;
  const output = asNumber(raw.output_tokens) ?? 0;
  const cacheRead = asNumber(raw.cache_read_input_tokens);
  const cacheWrite = asNumber(raw.cache_creation_input_tokens);
  return {
    input,
    output,
    ...(cacheRead !== undefined && { cacheRead }),
    ...(cacheWrite !== undefined && { cacheWrite }),
  };
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
