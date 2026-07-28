# Multi-region Logto (dev harness)

Two independent Logto deployments, each with its own Postgres, plus a global
directory that maps a keyed hash of an email to a region. Demonstrates the
residency design: a user's records live in exactly one region, and the only
global component stores hashes rather than identifiers.

```
                    portal (logto-portal, :3000)
                              │
                    ┌─────────▼─────────┐        ┌──────────────────────┐
                    │  resolve region   │───────▶│  directory  :3300    │
                    │  before password  │        │  HMAC(email) → region│
                    └────┬─────────┬────┘        └──────────────────────┘
              ┌──────────▼──┐   ┌──▼───────────┐
              │  logto-eu   │   │  logto-us    │   stock Logto, own DB_URL,
              │    :3101    │   │    :3201     │   own issuer + signing keys
              │ postgres-eu │   │ postgres-us  │   all PII lives here
              │    :5442    │   │    :5452     │
              └─────────────┘   └──────────────┘
```

## Running it

```bash
docker compose -f docker-compose.multi-region.yml up -d
node ops/multi-region/seed.mjs
```

The seed prints the portal configuration. Copy it into `logto-portal/.env.local`
and start the portal. To verify:

```bash
LOGTO_EU_APP_ID=… LOGTO_EU_APP_SECRET=… \
LOGTO_US_APP_ID=… LOGTO_US_APP_SECRET=… \
node ops/multi-region/verify.mjs
```

| Service | Port | Notes |
|---|---|---|
| logto-eu | 3101 / 3102 | app / admin console |
| logto-us | 3201 / 3202 | app / admin console |
| directory | 3300 | `POST /resolve`, `PUT /entries` |
| postgres-eu | 5442 | exposed so the leak scan can query it directly |
| postgres-us | 5452 | same |

Seeded users, password `Silktide-Region-Test-2026!`:
`alice@eu-example.com` and `bob@eu-example.com` (EU);
`carol@us-example.com` and `dave@us-example.com` (US).

## What the verify script proves

1. The directory routes each identifier to the right region, and an unknown
   identifier resolves to nothing.
2. A full OIDC sign-in succeeds against that region, ending in a token whose
   `iss` is that region's issuer — `http://localhost:3101/oidc` vs `:3201`.
   Separate issuers are the point: the app configures its SDK per region, so
   there is never any ambiguity about which deployment to call for tokens.
3. Each database holds only its own users.
4. After normal use, nothing of one region's users appears in the other's
   database. The scan walks every text/varchar/jsonb column in
   `information_schema.columns` rather than a hand-written table list, because a
   hand-written list goes stale the moment someone adds a table.
5. The same credentials are rejected by the other region.

## A finding worth knowing

Step 6 of the verify script is reported, not asserted. **A rejected cross-region
sign-in still writes the attempted email into that region's `logs` table.**
Logto audits the attempt, identifier included, in whichever deployment served
it — so a misrouted request (a stale region cookie, a typo, a probe) leaves a
person's email address in a region where they have no account.

Two mitigations, and you want both:

- Do not let misrouted requests reach a region at all. The portal resolves the
  region *before* showing a password field, which is what prevents this in the
  normal path.
- Retain audit logs for a bounded time. See `ops/oidc-retention/` for the
  related gap: Logto never deletes expired `oidc_model_instances` rows either.

## Notes on the setup

- **`INTEGRATION_TEST=1` is set on both Logto containers.** This disables
  Management API token validation
  (`packages/core/src/middleware/koa-auth/index.ts:28`) so the seed can create
  users with a `development-user-id` header instead of bootstrapping an M2M app.
  **Never set it on a real deployment.**
- **Self-service sign-up is turned off.** Logto rejects an email sign-up
  identifier unless `verify` is on, and leaving `username` as a sign-up
  identifier makes Logto demand one at sign-in from users who lack it
  (`user.missing_profile` at `/submit`). Turning sign-up off also matches the
  residency design: a user's region is decided when the account is provisioned,
  so accounts arrive through the Management API or a migration, not an anonymous
  form.
- **The directory service reuses the Logto image** purely because it already
  ships Node. It is dependency-free (`node:http` + `node:crypto`).
- **The directory refuses to repoint an existing entry** (409). Moving a user
  between regions is a residency change and must be an explicit, audited
  migration, not a side effect of re-running the seed.
- **`/resolve` answers with the same shape for a hit and a miss.** It is an
  account-existence oracle otherwise. A production directory also needs rate
  limiting per IP and globally; Logto's own `BasicSentinel` is per-region and
  cannot cover it.
- **The seed reconciles redirect URIs** on re-run, so running it with a
  different `PORTAL_CALLBACK` registers the new one rather than failing later
  with `invalid_redirect_uri`.

## Resetting

```bash
docker compose -f docker-compose.multi-region.yml down -v
```

`-v` drops the volumes, including the directory's entry file.
