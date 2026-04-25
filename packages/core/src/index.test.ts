import { describe, expect, it } from 'vitest';
import { CORE_VERSION } from './index.js';

describe('core bootstrap', () => {
  it('exports CORE_VERSION', () => {
    expect(CORE_VERSION).toBe('0.0.0');
  });
});
