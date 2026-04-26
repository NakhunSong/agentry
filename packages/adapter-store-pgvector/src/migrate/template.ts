const TOKEN = '{{EMBEDDING_DIM}}';

export function substituteEmbeddingDim(sql: string, dim: number): string {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`embeddingDim must be a positive integer, got ${String(dim)}`);
  }
  return sql.split(TOKEN).join(String(dim));
}
