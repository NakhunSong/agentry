import { describe, expect, it } from 'vitest';
import {
  mapAppMentionToIncomingEvent,
  type SlackAppMentionEnvelope,
  SlackEventMappingError,
} from './slack-event-mapping.js';

function buildEnvelope(
  overrides: Partial<SlackAppMentionEnvelope['event']> = {},
): SlackAppMentionEnvelope {
  return {
    event_id: 'Ev0123ABCD',
    team_id: 'T0G9PQBBK',
    event: {
      type: 'app_mention',
      user: 'U123USER',
      text: '<@UBOTID> hello',
      ts: '1700000123.000200',
      thread_ts: '1700000000.000100',
      channel: 'C9876CHAN',
      event_ts: '1700000123.000200',
      ...overrides,
    },
  };
}

describe('mapAppMentionToIncomingEvent', () => {
  it('maps a thread reply mention to a canonical IncomingEvent', () => {
    const incoming = mapAppMentionToIncomingEvent(buildEnvelope());

    expect(incoming.channelKind).toBe('slack');
    expect(incoming.channelNativeRef).toBe('slack:C9876CHAN:1700000000.000100');
    expect(incoming.author).toEqual({ channelUserId: 'U123USER' });
    expect(incoming.payload.text).toBe('<@UBOTID> hello');
    expect(incoming.threading).toEqual({
      channel: 'C9876CHAN',
      message_ts: '1700000123.000200',
      thread_ts: '1700000000.000100',
      team_id: 'T0G9PQBBK',
    });
    expect(incoming.idempotencyKey).toBe('Ev0123ABCD');
  });

  it('canonicalizes a bare-channel mention by promoting message_ts to thread_ts', () => {
    const env = buildEnvelope();
    const eventNoThread = { ...env.event };
    delete (eventNoThread as { thread_ts?: string }).thread_ts;
    const incoming = mapAppMentionToIncomingEvent({ ...env, event: eventNoThread });

    expect(incoming.channelNativeRef).toBe('slack:C9876CHAN:1700000123.000200');
    expect(incoming.threading).toMatchObject({
      message_ts: '1700000123.000200',
      thread_ts: '1700000123.000200',
    });
  });

  it('parses receivedAt from event_ts in seconds', () => {
    const incoming = mapAppMentionToIncomingEvent(buildEnvelope({ event_ts: '1700000456.789000' }));
    expect(incoming.receivedAt.getTime()).toBe(1700000456789);
  });

  it('passes empty text through when event.text is missing', () => {
    const env = buildEnvelope();
    const eventNoText = { ...env.event };
    delete (eventNoText as { text?: string }).text;
    const incoming = mapAppMentionToIncomingEvent({ ...env, event: eventNoText });
    expect(incoming.payload.text).toBe('');
  });

  it('throws SlackEventMappingError when event.user is missing', () => {
    const env = buildEnvelope();
    const eventNoUser = { ...env.event };
    delete (eventNoUser as { user?: string }).user;
    expect(() => mapAppMentionToIncomingEvent({ ...env, event: eventNoUser })).toThrow(
      SlackEventMappingError,
    );
  });

  it('throws SlackEventMappingError when event_id is missing', () => {
    const env = { ...buildEnvelope(), event_id: '' };
    expect(() => mapAppMentionToIncomingEvent(env)).toThrow(/event_id/);
  });

  it('throws SlackEventMappingError when team_id is missing', () => {
    const env = { ...buildEnvelope(), team_id: '' };
    expect(() => mapAppMentionToIncomingEvent(env)).toThrow(/team_id/);
  });
});
