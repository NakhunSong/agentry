CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, display_name)
VALUES ('default', 'Default Tenant')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE sessions (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  TEXT NOT NULL REFERENCES tenants(id),
  channel_kind               TEXT NOT NULL,
  channel_native_ref         TEXT NOT NULL,
  started_at                 TIMESTAMPTZ NOT NULL,
  last_active_at             TIMESTAMPTZ NOT NULL,
  status                     TEXT NOT NULL CHECK (status IN ('active','idle','ended')),
  participants               JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  distilled_through_seq_no   BIGINT NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, channel_kind, channel_native_ref)
);

CREATE INDEX sessions_idle_idx
  ON sessions (status, last_active_at)
  WHERE status IN ('active','idle');

CREATE TABLE turns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq_no        BIGSERIAL UNIQUE NOT NULL,
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  author_role   TEXT NOT NULL CHECK (author_role IN ('user','agent','system')),
  author_ref    JSONB,
  content_text  TEXT NOT NULL,
  content_extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX turns_session_seq_idx ON turns (session_id, seq_no);

CREATE TABLE source_refs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  source_kind TEXT NOT NULL,
  locator     TEXT NOT NULL,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_kind, locator)
);

CREATE TABLE knowledge_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  external_id           TEXT,
  source_type           TEXT NOT NULL CHECK (source_type IN ('project_seed','user_session','external_sync')),
  kind                  TEXT NOT NULL CHECK (kind IN ('fact','decision','qa_pair','procedure')),
  text                  TEXT NOT NULL,
  text_canonical_hash   CHAR(64) NOT NULL,
  embedding             vector({{EMBEDDING_DIM}}),

  extractor_self_rating NUMERIC(3,2) NOT NULL CHECK (extractor_self_rating BETWEEN 0 AND 1),
  n_confirmations       INT NOT NULL DEFAULT 1,
  last_referenced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confidence_snapshot   NUMERIC(3,2) NOT NULL CHECK (confidence_snapshot BETWEEN 0 AND 1),

  derived_from_kind     TEXT NOT NULL CHECK (derived_from_kind IN ('session','external')),
  derived_from_session  UUID    REFERENCES sessions(id)    ON DELETE SET NULL,
  derived_from_turn_lo  BIGINT  REFERENCES turns(seq_no)   ON DELETE SET NULL,
  derived_from_turn_hi  BIGINT  REFERENCES turns(seq_no)   ON DELETE SET NULL,
  derived_from_source   UUID    REFERENCES source_refs(id) ON DELETE SET NULL,
  derived_from_locator  TEXT,

  extractor_version     TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

  CHECK (
    (derived_from_kind='external' AND derived_from_source IS NOT NULL)
 OR  derived_from_kind='session'
  )
);

CREATE UNIQUE INDEX knowledge_items_seed_external_uniq
  ON knowledge_items (tenant_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX knowledge_items_canonical_uniq
  ON knowledge_items (tenant_id, source_type, text_canonical_hash);

CREATE INDEX knowledge_items_embedding_idx
  ON knowledge_items USING hnsw (embedding vector_cosine_ops);

CREATE INDEX knowledge_items_tenant_kind_idx
  ON knowledge_items (tenant_id, source_type, kind);
