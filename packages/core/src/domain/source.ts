import type { SourceId, TenantId } from './ids.js';

// Open string: 'github' | 'notion' | 'web' | 'manual' | … — adapter-defined.
export type SourceKind = string;

export interface SourceRefInput {
  readonly tenantId: TenantId;
  readonly sourceKind: SourceKind;
  readonly locator: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceRef extends SourceRefInput {
  readonly id: SourceId;
  readonly createdAt: Date;
}
