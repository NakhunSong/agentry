-- Turn idempotency: `recordTurn` becomes idempotent when the caller passes an
-- idempotencyKey. Per-(session_id, idempotency_key) partial unique guarantees
-- at-most-one row when retrying the same logical event (pg-boss at-least-once
-- redelivery, channel-adapter retries, etc.).
--
-- Nullable column + partial unique because only USER turns currently carry a
-- stable key (the inbound `IncomingEvent.idempotencyKey`). Agent turns are
-- produced fresh on every job invocation — they get NULL and are not deduped.

ALTER TABLE turns ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX turns_session_idempotency_uniq
  ON turns (session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
