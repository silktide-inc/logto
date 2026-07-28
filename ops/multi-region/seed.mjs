/**
 * Seed both regions with test users and register them in the region directory.
 *
 *   node ops/multi-region/seed.mjs
 *
 * Per region: switch the sign-in experience to email + password, create (or
 * reuse) the portal application, create the test users, then record
 * HMAC(email) -> region in the directory.
 *
 * Idempotent -- safe to re-run. Uses the `development-user-id` Management API
 * bypass enabled by INTEGRATION_TEST=1 in the compose file, so it needs no M2M
 * credentials. Dev only.
 */

const DIRECTORY = process.env.DIRECTORY_URL ?? 'http://localhost:3300';
const DIRECTORY_ADMIN_TOKEN = process.env.DIRECTORY_ADMIN_TOKEN ?? 'dev-only-admin-token';
const PORTAL_CALLBACK = process.env.PORTAL_CALLBACK ?? 'http://localhost:3000/callback';
const PORTAL_ORIGIN = new URL(PORTAL_CALLBACK).origin;

/**
 * The silktide-qa auth service is a second confidential client per region. The
 * portal drives the Experience API, but the authorization code is minted for
 * *this* client and redeemed by the auth service, which owns state + PKCE and
 * holds the resulting tokens. One deployment serves every region, so the
 * callback is region-independent.
 */
const AUTH_SERVICE_CALLBACK =
  process.env.AUTH_SERVICE_CALLBACK ?? 'http://localhost:9570/v1/login/callback';
const AUTH_SERVICE_ORIGIN = new URL(AUTH_SERVICE_CALLBACK).origin;

/** Not a real-world password; it only has to survive Logto's `min(1)` guard. */
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'Silktide-Region-Test-2026!';

const REGIONS = [
  {
    id: 'eu',
    endpoint: 'http://localhost:3101',
    users: [
      { primaryEmail: 'alice@eu-example.com', name: 'Alice (EU)' },
      { primaryEmail: 'bob@eu-example.com', name: 'Bob (EU)' },
    ],
  },
  {
    id: 'us',
    endpoint: 'http://localhost:3201',
    users: [
      { primaryEmail: 'carol@us-example.com', name: 'Carol (US)' },
      { primaryEmail: 'dave@us-example.com', name: 'Dave (US)' },
    ],
  },
];

const api = async (endpoint, path, { method = 'GET', body } = {}) => {
  const response = await fetch(new URL(`api${path}`, endpoint), {
    method,
    headers: {
      'content-type': 'application/json',
      // Accepted because INTEGRATION_TEST=1; see koa-auth/index.ts:28.
      'development-user-id': 'multi-region-seed',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status} ${text}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

const waitFor = async (label, check, { attempts = 60, delayMs = 2000 } = {}) => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await check();
      return;
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(`${label} never became ready: ${error.message}`);
      }
      if (attempt === 1 || attempt % 5 === 0) {
        process.stdout.write(`  waiting for ${label} (${attempt}/${attempts})\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

/**
 * OSS seeds username-based sign-in. Switch sign-IN to email so the directory has
 * an identifier worth routing on.
 *
 * Self-service sign-UP is turned off entirely. Two reasons: Logto rejects an
 * email sign-up identifier unless `verify` is on
 * (`sign_in_experiences.passwordless_requires_verify`), which would need a real
 * email connector; and leaving `username` as a sign-up identifier makes Logto
 * demand one at sign-in from users who do not have it, failing `/submit` with
 * `user.missing_profile`.
 *
 * This also matches the residency design: a user's region is decided when their
 * account is provisioned, so accounts arrive through the Management API (or the
 * Auth0 migration), not through an anonymous sign-up form.
 */
const useEmailSignIn = (endpoint) =>
  api(endpoint, '/sign-in-exp', {
    method: 'PATCH',
    body: {
      signUp: { identifiers: [], password: false, verify: false },
      signInMode: 'SignIn',
      signIn: {
        methods: [
          {
            identifier: 'email',
            password: true,
            verificationCode: false,
            isPasswordPrimary: true,
          },
        ],
      },
    },
  });

const ensureApp = async (endpoint, { name, description, callback, origin }) => {
  const existing = await api(endpoint, '/applications?page=1&page_size=100');
  const found = existing.find((app) => app.name === name);

  if (!found) {
    return api(endpoint, '/applications', {
      method: 'POST',
      body: {
        name,
        type: 'Traditional',
        description,
        oidcClientMetadata: {
          redirectUris: [callback],
          postLogoutRedirectUris: [origin],
        },
      },
    });
  }

  // Reconcile rather than skip: re-running with a different callback (a
  // different dev port, say) should register it, not silently keep the old one
  // and fail at redirect time with `invalid_redirect_uri`.
  const redirectUris = [...new Set([...found.oidcClientMetadata.redirectUris, callback])];
  const postLogoutRedirectUris = [
    ...new Set([...found.oidcClientMetadata.postLogoutRedirectUris, origin]),
  ];

  const unchanged =
    redirectUris.length === found.oidcClientMetadata.redirectUris.length &&
    postLogoutRedirectUris.length === found.oidcClientMetadata.postLogoutRedirectUris.length;

  if (unchanged) {
    return found;
  }

  return api(endpoint, `/applications/${found.id}`, {
    method: 'PATCH',
    body: { oidcClientMetadata: { ...found.oidcClientMetadata, redirectUris, postLogoutRedirectUris } },
  });
};

/**
 * The `secret` field on the application response carries an `#internal:` prefix
 * and is not the OIDC client secret. The usable one lives in the application's
 * secrets collection.
 */
const appSecretOf = async (endpoint, applicationId) => {
  const secrets = await api(endpoint, `/applications/${applicationId}/secrets`);
  const usable = secrets.find(({ expiresAt }) => !expiresAt) ?? secrets[0];
  if (!usable) {
    throw new Error(`application ${applicationId} has no usable secret`);
  }
  return usable.value;
};

const ensureUser = async (endpoint, user) => {
  try {
    const created = await api(endpoint, '/users', {
      method: 'POST',
      body: { ...user, password: TEST_PASSWORD },
    });
    return { ...created, created: true };
  } catch (error) {
    if (error.status !== 422) throw error;

    // Already present from an earlier run.
    const matches = await api(
      endpoint,
      `/users?page=1&page_size=1&search=${encodeURIComponent(user.primaryEmail)}`
    );
    if (matches.length === 0) throw error;
    return { ...matches[0], created: false };
  }
};

const registerRegion = async (identifier, region) => {
  const response = await fetch(new URL('/entries', DIRECTORY), {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${DIRECTORY_ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ identifier, region }),
  });

  if (response.status === 409) {
    const { region: existing } = await response.json();
    throw new Error(
      `${identifier} is already assigned to '${existing}'. Repointing is a residency ` +
        `change and must be done deliberately, not by re-seeding.`
    );
  }
  if (!response.ok) {
    throw new Error(`directory PUT failed: ${response.status} ${await response.text()}`);
  }
};

const main = async () => {
  await waitFor('directory', async () => {
    const response = await fetch(new URL('/health', DIRECTORY));
    if (!response.ok) throw new Error(`status ${response.status}`);
  });

  const portalEnv = [];
  const authServiceEnv = [];

  for (const region of REGIONS) {
    console.log(`\n=== ${region.id.toUpperCase()} (${region.endpoint}) ===`);

    await waitFor(`logto-${region.id}`, () => api(region.endpoint, '/status'));

    await useEmailSignIn(region.endpoint);
    console.log('  sign-in experience: email + password');

    const portalApp = await ensureApp(region.endpoint, {
      name: 'Logto Portal',
      description: 'Region-aware portal (multi-region dev harness)',
      callback: PORTAL_CALLBACK,
      origin: PORTAL_ORIGIN,
    });
    const portalSecret = await appSecretOf(region.endpoint, portalApp.id);
    console.log(`  portal application:       ${portalApp.id}`);

    const authApp = await ensureApp(region.endpoint, {
      name: 'Silktide Auth Service',
      description: 'silktide-qa services/auth — redeems the code, owns state + PKCE',
      callback: AUTH_SERVICE_CALLBACK,
      origin: AUTH_SERVICE_ORIGIN,
    });
    const authSecret = await appSecretOf(region.endpoint, authApp.id);
    console.log(`  auth-service application: ${authApp.id}`);

    for (const user of region.users) {
      const result = await ensureUser(region.endpoint, user);
      await registerRegion(user.primaryEmail, region.id);
      console.log(
        `  user: ${user.primaryEmail} -> ${result.id} ${result.created ? '(created)' : '(existing)'}`
      );
    }

    const upper = region.id.toUpperCase();
    portalEnv.push(
      `LOGTO_${upper}_ENDPOINT=${region.endpoint}`,
      `LOGTO_${upper}_APP_ID=${portalApp.id}`,
      `LOGTO_${upper}_APP_SECRET=${portalSecret}`
    );
    authServiceEnv.push(
      `LOGTO_${upper}_ENDPOINT=${region.endpoint}`,
      `LOGTO_${upper}_APP_CLIENT_ID=${authApp.id}`,
      `LOGTO_${upper}_APP_CLIENT_SECRET=${authSecret}`
    );
  }

  console.log('\n=== portal configuration ===');
  console.log('Copy into logto-portal/.env.local:\n');
  console.log(portalEnv.join('\n'));
  console.log(`\nDIRECTORY_URL=${DIRECTORY}`);

  console.log('\n=== auth service configuration ===');
  console.log('Copy into silktide-qa/services/auth/.env.local:\n');
  console.log(authServiceEnv.join('\n'));
  console.log(`AUTH_SERVICE_URL=${AUTH_SERVICE_ORIGIN}`);
  console.log(`LOGTO_REGIONS=${REGIONS.map(({ id }) => id).join(',')}`);

  console.log(`\nTest password for every seeded user: ${TEST_PASSWORD}`);
};

await main();
