import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalize } from './canonicalize.js';

describe('canonicalize', () => {
  it('lowercases', () => {
    expect(canonicalize('Hello World')).toBe('hello world');
  });

  it('collapses internal whitespace', () => {
    expect(canonicalize('a  b\t\nc')).toBe('a b c');
  });

  it('strips trailing punctuation', () => {
    expect(canonicalize('agentry rocks!')).toBe('agentry rocks');
    expect(canonicalize('really??')).toBe('really');
    expect(canonicalize('end.')).toBe('end');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalize('  hello  ')).toBe('hello');
  });

  it('preserves internal punctuation', () => {
    expect(canonicalize("it's fine, really.")).toBe("it's fine, really");
  });
});

describe('canonicalHash', () => {
  it('returns 64-char hex SHA-256', () => {
    const h = canonicalHash('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(canonicalHash('hello')).toBe(canonicalHash('hello'));
  });

  it('collapses canonicalization-equivalent inputs', () => {
    expect(canonicalHash('Hello World!')).toBe(canonicalHash('hello   world'));
  });

  it('distinguishes semantically different inputs', () => {
    expect(canonicalHash('hello')).not.toBe(canonicalHash('world'));
  });
});
