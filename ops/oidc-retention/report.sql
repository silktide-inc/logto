-- Read-only view of what the sweep would remove. Safe to run in production.
--
-- Required psql variables: default_retention, interaction_retention

\set ON_ERROR_STOP on

select
  model_name,
  count(*)                                          as total,
  count(*) filter (where expires_at < now())        as expired,
  count(*) filter (
    where expires_at < now() - (
      case
        when model_name = 'Interaction' then :'interaction_retention'::interval
        else :'default_retention'::interval
      end
    )
  )                                                 as sweepable,
  min(expires_at)                                   as oldest_expiry
from oidc_model_instances
group by model_name
order by sweepable desc, model_name;

-- Interactions are the only model whose payload can carry credential material
-- (InteractionStorage.profile -> passwordEncrypted / primaryEmail). It is
-- populated during registration, password reset, and action-provisioned
-- sign-in; a plain sign-in of an existing user leaves it empty. Counting it
-- tells you how much of the backlog is actually sensitive.
select
  count(*)                                                              as expired_interactions,
  count(*) filter (where payload->'result'->'profile' ? 'passwordEncrypted') as with_password_hash,
  count(*) filter (where payload->'result'->'profile' ? 'primaryEmail')      as with_email,
  count(*) filter (where payload->'result'->'profile' ? 'primaryPhone')      as with_phone
from oidc_model_instances
where model_name = 'Interaction'
  and expires_at < now();
