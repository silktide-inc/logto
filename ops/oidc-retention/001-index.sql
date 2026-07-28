-- One-time, optional but strongly recommended before sweeping a large table.
--
-- oidc_model_instances ships with no index on expires_at, so each sweep batch
-- is a sequential scan. On a small table that is fine. On a production table it
-- means every batch rescans from the beginning, and the sweep degrades to
-- O(batches x table size).
--
-- CONCURRENTLY takes no exclusive lock, so this is safe to run against a live
-- database -- but it cannot run inside a transaction block, so invoke this file
-- on its own (psql -f 001-index.sql), not as part of a larger script.
--
-- This is additive to Logto's schema. `logto db alteration deploy` does not drop
-- indexes it does not know about, so it survives upgrades. Re-run after any
-- restore-from-dump that rebuilds the schema.

create index concurrently if not exists oidc_model_instances__expires_at
  on oidc_model_instances (expires_at);
