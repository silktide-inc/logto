# OIDC artifact retention sweep

Logto never deletes expired rows from `oidc_model_instances`. This removes them.

## The problem

- Reads do not filter on expiry — `findByModel` is `where model_name = $1` with no
  `expires_at` predicate ([`packages/core/src/queries/oidc-model-instance.ts:60`](../../packages/core/src/queries/oidc-model-instance.ts)).
  oidc-provider rejects expired artifacts from the payload's own `exp`, so this is
  functionally correct — the rows are simply never cleaned up.
- Every `DELETE` in that module is targeted: by id, by grant id, by user id, or the
  duplicate-`uid` cleanup. None is expiry-driven.
- The CLI has no cleanup command (`connector`, `database`, `install` only), and
  `Tenant` schedules only signing-key rotation.

So the table grows without bound. Confirmed on a live instance: 11 expired
`Interaction` rows, 3 expired `AccessToken`, 2 expired `AuthorizationCode`, oldest
expired four days earlier, none removed.

Autovacuum does not help. The table's tuned `autovacuum_*` settings reclaim space
from dead tuples left by updates; an expired-but-live row is not a dead tuple.

### How sensitive is it

Flow-dependent, and worth measuring rather than assuming. `InteractionStorage.profile`
*can* hold `passwordEncrypted`, `passwordEncryptionMethod` and the plaintext
`primaryEmail`/`primaryPhone` ([`packages/core/src/routes/experience/types.ts:197`](../../packages/core/src/routes/experience/types.ts)),
but it is only populated during **registration**, **password reset**, and
**action-provisioned sign-in**. A plain sign-in of an existing user leaves it empty —
verified against a live database, where all 11 expired interactions had an empty
profile.

`report.sql` counts this directly, so you can size the real exposure before deciding
your retention window.

Separately, `Session` and `Grant` payloads carry `accountId` (a pseudonymous user id)
and are long-lived by design — days to months. They are still personal data under
GDPR, and they are still swept once expired.

## Usage

```bash
DB_URL=postgres://user:pass@host:5432/logto ./sweep.sh --dry-run   # report only
DB_URL=postgres://user:pass@host:5432/logto ./sweep.sh            # delete
```

| Variable | Default | Notes |
|---|---|---|
| `DB_URL` | *required* | Must be the **owner** role — see below |
| `INTERACTION_RETENTION` | `1 hour` | Grace after expiry for `Interaction` rows |
| `DEFAULT_RETENTION` | `24 hours` | Grace after expiry for everything else |
| `BATCH_SIZE` | `5000` | Rows per transaction |
| `MAX_BATCHES` | `1000` | Safety stop; exits 2 if hit |

Nothing is deleted until `expires_at < now() - retention`. The grace period absorbs
clock skew between app servers and the database, and covers the 3-second refresh-token
reuse-detection interval. Shorten `INTERACTION_RETENTION` to minimise credential
retention; shortening `DEFAULT_RETENTION` below an hour buys little, since those rows
are pseudonymous.

## Run it as the owner role

`oidc_model_instances` has row-level security **enabled but not forced**
(`relrowsecurity = t`, `relforcerowsecurity = f`), so the table owner — the role in
`DB_URL` that ran `logto db seed` — bypasses the policy and sweeps every tenant.

A per-tenant role (`logto_tenant_<db>_<tenant>`) would silently clean only its own
rows and report success. `sweep.sh` checks for this and refuses to run, rather than
letting you believe a partial sweep was a full one.

## Add the index first on a large table

`oidc_model_instances` ships with **no index on `expires_at`**, so each batch is a
sequential scan and the sweep degrades to O(batches × table size). Before the first
run against anything substantial:

```bash
psql "$DB_URL" -f 001-index.sql
```

`CONCURRENTLY` takes no exclusive lock, so it is safe on a live database — but it
cannot run inside a transaction block, which is why it is a separate file. The index
is additive; `logto db alteration deploy` does not drop indexes it does not know
about, so it survives upgrades. Re-add it after a restore that rebuilds the schema.

## Scheduling

Hourly is a reasonable default; the first run against an unswept table will be much
larger than the steady state, so run it manually once and watch it.

- **Kubernetes** — a `CronJob` on the `postgres:17` image mounting this directory.
- **pg_cron** — schedule `sweep.sql` directly; note it is one batch per call, so
  either schedule it frequently or wrap the loop in a `DO` block.
- **systemd timer / cron** — call `sweep.sh` with `DB_URL` from your secret store.

Run it against **each regional database separately**. It sweeps all tenants within one
database, not across databases.

## What this does not do

- It does not shorten how long artifacts live — that is OIDC TTL configuration in
  Logto, and it is the better lever if interactions are surviving longer than you want.
- It does not touch `logs`, `passcodes`, `one_time_tokens` or `sentinel_activities`,
  which have their own retention questions.
- It does not `VACUUM`. The table's existing autovacuum tuning handles reclaim once
  the rows are actually dead.
