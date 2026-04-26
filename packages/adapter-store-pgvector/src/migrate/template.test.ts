import { describe, expect, it } from 'vitest';
import { substituteEmbeddingDim } from './template.js';

describe('substituteEmbeddingDim', () => {
  it('replaces every occurrence of the placeholder with the given dimension', () => {
    const sql = 'vector({{EMBEDDING_DIM}}), other vector({{EMBEDDING_DIM}})';
    expect(substituteEmbeddingDim(sql, 1024)).toBe('vector(1024), other vector(1024)');
  });

  it('leaves SQL without the placeholder unchanged', () => {
    const sql = 'CREATE TABLE foo (id INT);';
    expect(substituteEmbeddingDim(sql, 1024)).toBe(sql);
  });

  it('rejects non-integer dimensions', () => {
    expect(() => substituteEmbeddingDim('x', 1.5)).toThrow(/positive integer/);
  });

  it('rejects zero', () => {
    expect(() => substituteEmbeddingDim('x', 0)).toThrow(/positive integer/);
  });

  it('rejects negative dimensions', () => {
    expect(() => substituteEmbeddingDim('x', -1)).toThrow(/positive integer/);
  });

  it('rejects NaN', () => {
    expect(() => substituteEmbeddingDim('x', Number.NaN)).toThrow(/positive integer/);
  });
});
