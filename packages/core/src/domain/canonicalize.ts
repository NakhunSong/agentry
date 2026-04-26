import { createHash } from 'node:crypto';

// Per knowledge-store design §3: lowercase, collapse whitespace, strip
// trailing punctuation. Used as the dedup key (hashed into SHA-256), not for
// display — preserve raw `text` separately.
export function canonicalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

export function canonicalHash(text: string): string {
  return createHash('sha256').update(canonicalize(text)).digest('hex');
}
