-- Delete one batch of expired OIDC artifacts.
--
-- Run repeatedly until it reports 0 (sweep.sh does this for you).
-- Each invocation is its own transaction so locks stay short on a write-hot table.
--
-- Required psql variables:
--   default_retention      interval, e.g. '24 hours'
--   interaction_retention  interval, e.g. '1 hour'
--   batch_size             integer,  e.g. 5000
--
-- Rows are matched by primary key rather than ctid so that a concurrent HOT
-- update cannot cause us to delete the wrong tuple.

\set ON_ERROR_STOP on

with victims as (
  select id
  from oidc_model_instances
  where expires_at < now() - (
    case
      when model_name = 'Interaction' then :'interaction_retention'::interval
      else :'default_retention'::interval
    end
  )
  limit :batch_size
),
deleted as (
  delete from oidc_model_instances o
  using victims v
  where o.id = v.id
  returning 1
)
select count(*)::bigint as deleted from deleted;
