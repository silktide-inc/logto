#!/usr/bin/env bash
#
# Delete expired OIDC artifacts from a Logto database.
#
# Logto never removes expired rows from oidc_model_instances -- reads do not
# filter on expires_at and every DELETE in the query layer is targeted (by id,
# grant id, user id, or uid-duplicate cleanup). The table therefore grows without
# bound, and expired Interaction rows can retain credential material.
#
# Usage:
#   DB_URL=postgres://user:pass@host:5432/logto ./sweep.sh [--dry-run]
#
# Environment:
#   DB_URL                 required. Must be the OWNER role (see RLS note below).
#   DEFAULT_RETENTION      default '24 hours'. Grace after expiry for tokens/sessions.
#   INTERACTION_RETENTION  default '1 hour'.   Grace after expiry for Interactions.
#   BATCH_SIZE             default 5000.
#   MAX_BATCHES            default 1000. Safety stop.
#
# RLS: oidc_model_instances has row-level security ENABLED but not FORCED, so the
# table owner bypasses it and sweeps every tenant. Running this as a per-tenant
# role (logto_tenant_<db>_<tenant>) silently cleans only that tenant's rows.
# The script verifies this and refuses to run otherwise.

set -euo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

: "${DB_URL:?DB_URL is required}"
DEFAULT_RETENTION="${DEFAULT_RETENTION:-24 hours}"
INTERACTION_RETENTION="${INTERACTION_RETENTION:-1 hour}"
BATCH_SIZE="${BATCH_SIZE:-5000}"
MAX_BATCHES="${MAX_BATCHES:-1000}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

psql_run() {
  psql "$DB_URL" \
    --no-psqlrc \
    -v ON_ERROR_STOP=1 \
    -v "default_retention=$DEFAULT_RETENTION" \
    -v "interaction_retention=$INTERACTION_RETENTION" \
    -v "batch_size=$BATCH_SIZE" \
    "$@"
}

# Refuse to run as a role that RLS would silently scope down.
owner_check=$(psql_run -tA -c "
  select case
    when pg_get_userbyid(c.relowner) = current_user then 'owner'
    when (select rolsuper from pg_roles where rolname = current_user) then 'superuser'
    when (select rolbypassrls from pg_roles where rolname = current_user) then 'bypassrls'
    else 'restricted'
  end
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relname = 'oidc_model_instances' and n.nspname = 'public';
")

if [[ "$owner_check" == "restricted" ]]; then
  echo "ERROR: current role is subject to row-level security on oidc_model_instances." >&2
  echo "       It would sweep only one tenant. Connect as the owner role from DB_URL." >&2
  exit 1
fi
if [[ -z "$owner_check" ]]; then
  echo "ERROR: oidc_model_instances not found. Is DB_URL pointing at a Logto database?" >&2
  exit 1
fi

echo "Connected as '$(psql_run -tA -c 'select current_user')' ($owner_check)"
echo "Retention: interactions '$INTERACTION_RETENTION', everything else '$DEFAULT_RETENTION'"
echo
psql_run -f "$HERE/report.sql"

if [[ "$DRY_RUN" == "1" ]]; then
  echo
  echo "Dry run -- nothing deleted."
  exit 0
fi

echo
total=0
for (( batch = 1; batch <= MAX_BATCHES; batch++ )); do
  deleted=$(psql_run -tA -f "$HERE/sweep.sql")
  total=$(( total + deleted ))
  if [[ "$deleted" == "0" ]]; then
    echo "Done after $(( batch - 1 )) batch(es). Deleted $total row(s)."
    exit 0
  fi
  echo "  batch $batch: deleted $deleted (running total $total)"
done

echo "Stopped at MAX_BATCHES=$MAX_BATCHES with $total row(s) deleted; more may remain." >&2
exit 2
