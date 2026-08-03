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

import { readFile } from 'node:fs/promises';

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

/**
 * Extra EU users, comma-separated emails. The Silktide CLI passes the local
 * Marvel developer account here so the same person exists in Logto, the
 * directory AND Marvel — which is what lets a local sign-in resolve to a real
 * assignee instead of ?error=no-account.
 */
const EXTRA_EU_USERS = (process.env.SEED_EXTRA_EU_USERS ?? '')
  .split(',')
  .map((email) => email.trim())
  .filter(Boolean)
  .map((email) => ({ primaryEmail: email, name: email.split('@')[0] }));

/**
 * Branded auth emails ported from Auth0 (see email-templates/README.md for the
 * mapping). Subjects sit here the way Auth0's sat in Marvel's
 * EmailTemplatesMap.php; the HTML lives next to this script. These DB-backed
 * templates (PUT /api/email-templates) take priority over the plain-text
 * fallbacks in the SMTP connector config.
 */
const EMAIL_TEMPLATES = [
  { templateType: 'ForgotPassword', subject: '🎉 Set your password', file: 'ForgotPassword.html' },
  { templateType: 'MfaVerification', subject: 'Your verification code', file: 'MfaVerification.html' },
  {
    templateType: 'BindMfa',
    subject: 'Invitation to enroll in Multifactor Authentication',
    file: 'BindMfa.html',
  },
  { templateType: 'Generic', subject: 'Your Silktide verification code', file: 'Generic.html' },
];

/**
 * Same values Marvel injects via Auth0Installer::applyLegalFooterPlaceholders
 * (config keys legal.entity_line / legal.trademark_holder).
 */
const LEGAL_ENTITY_LINE = 'Silktide Inc, 106 E 6th St Suite 400, Austin, TX 78701, USA';
const LEGAL_TRADEMARK_HOLDER = 'Silktide Inc';

const SMTP_CONNECTOR_ID = 'simple-mail-transfer-protocol';
// `mailpit` resolves inside the compose network, where the connector runs.
const SMTP_HOST = process.env.SEED_SMTP_HOST ?? 'mailpit';
const SMTP_PORT = Number(process.env.SEED_SMTP_PORT ?? 1025);
const SMTP_FROM = process.env.SEED_SMTP_FROM ?? 'Silktide <noreply@silktide.com>';

/**
 * `endpoint` is the direct host port the seed talks to (never depends on the
 * QA Traefik being up); `publicEndpoint` is what browsers and the portal/auth
 * services use — the ENDPOINT each container is configured with in
 * docker-compose.multi-region.yml, served by the silktide-qa Traefik. The
 * printed env blocks carry the public one.
 */
const REGIONS = [
  {
    id: 'eu',
    endpoint: 'http://localhost:3101',
    publicEndpoint: 'https://logto.eu.silktide.localhost',
    users: [
      { primaryEmail: 'alice@eu-example.com', name: 'Alice (EU)' },
      { primaryEmail: 'bob@eu-example.com', name: 'Bob (EU)' },
      ...EXTRA_EU_USERS,
    ],
  },
  {
    id: 'us',
    endpoint: 'http://localhost:3201',
    publicEndpoint: 'https://logto.us.silktide.localhost',
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
  // Some endpoints answer with plain text (e.g. "Created" from
  // POST /roles/:id/applications) rather than JSON.
  const payload = (() => {
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return text;
    }
  })();

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
 *
 * Branding and policies mirror what Auth0Installer pushed to Auth0:
 *
 * - color/logo: updateBranding() used #3D25DF and the login.silktide.com logo.
 *   The portal renders the main sign-in UI itself, but Logto-hosted pages still
 *   appear in edge flows (consent, SSO), so they should not look like Logto.
 * - passwordPolicy: Auth0 owned password rules, so Marvel has none to copy;
 *   this is a sensible baseline — check the Auth0 tenant policy for exact
 *   parity. `pwned` is safe here: under INTEGRATION_TEST=1 the check uses a
 *   local test list, no network.
 * - sentinelPolicy: lockout after 10 failed attempts, matching Auth0's
 *   brute-force threshold. Logto locks without sending Auth0's
 *   "blocked account" email — there is no email hook for it.
 * - mfa: factors enabled but NoPrompt, mirroring Auth0 where MFA existed but
 *   enrolment was by invitation rather than forced at sign-in.
 * - forgotPasswordMethods stays [] on purpose: password reset is the
 *   link-based flow owned by services/auth (one-time tokens), not Logto's
 *   code-based hosted flow. See email-templates/README.md.
 */
const configureSignInExperience = (endpoint) =>
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
      color: {
        primaryColor: '#3D25DF',
        isDarkModeEnabled: false,
        darkPrimaryColor: '#3D25DF',
      },
      branding: {
        logoUrl: 'https://login.silktide.com/images/silktide-logo.svg',
        darkLogoUrl: 'https://login.silktide.com/images/silktide-logo.svg',
      },
      // hideLogtoBranding is rejected by OSS ("not supported in this
      // environment") — it's a Cloud-plan toggle; OSS shows no badge anyway.
      passwordPolicy: {
        length: { min: 8, max: 256 },
        characterTypes: { min: 2 },
        rejects: { pwned: true, repetitionAndSequence: true, userInfo: true, words: [] },
      },
      sentinelPolicy: { maxAttempts: 10, lockoutDuration: 10 },
      mfa: { factors: ['Totp', 'WebAuthn', 'BackupCode'], policy: 'NoPrompt' },
    },
  });

/**
 * Every mail Logto sends goes through an email connector; without one the
 * forgot-password flow has no transport at all. Point SMTP at the compose
 * Mailpit. The config-level templates are deliberately plain — the branded
 * HTML uploaded by seedEmailTemplates wins — but the SMTP connector refuses a
 * config without entries for Register/SignIn/ForgotPassword/Generic, so every
 * type gets a fallback.
 */
const ensureEmailConnector = async (endpoint) => {
  const fallbackTemplate = (usageType) => ({
    usageType,
    contentType: 'text/plain',
    subject: 'Your Silktide verification code',
    content: 'Your Silktide verification code is {{code}}. It expires in 10 minutes.',
  });

  const config = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    // Must be non-empty: Logto's route layer strips empty objects from the
    // config on save, and the SMTP guard requires `auth` — a stored config
    // without it fails validation and every send breaks. Mailpit runs with
    // MP_SMTP_AUTH_ACCEPT_ANY, so the values themselves don't matter.
    auth: { user: 'silktide', pass: 'silktide-dev' },
    fromEmail: SMTP_FROM,
    templates: ['Register', 'SignIn', 'ForgotPassword', 'Generic', 'MfaVerification', 'BindMfa'].map(
      fallbackTemplate
    ),
  };

  const connectors = await api(endpoint, '/connectors');
  const existing = connectors.find(({ connectorId }) => connectorId === SMTP_CONNECTOR_ID);

  if (existing) {
    await api(endpoint, `/connectors/${existing.id}`, { method: 'PATCH', body: { config } });
    return;
  }

  await api(endpoint, '/connectors', {
    method: 'POST',
    body: { connectorId: SMTP_CONNECTOR_ID, config },
  });
};

/**
 * A Machine-to-Machine app per region for services/auth's Management API
 * calls (minting one-time tokens for the reset/welcome links, setting
 * passwords, creating users). The dev harness would also work through the
 * INTEGRATION_TEST bypass, but services/auth should authenticate the same way
 * it will in production: client_credentials against /oidc/token with
 * resource=https://default.logto.app/api and scope=all.
 */
const ensureM2mAccess = async (endpoint) => {
  const apps = await api(endpoint, '/applications?page=1&page_size=100');
  const app =
    apps.find(({ name }) => name === 'Silktide Auth Service M2M') ??
    (await api(endpoint, '/applications', {
      method: 'POST',
      body: {
        name: 'Silktide Auth Service M2M',
        type: 'MachineToMachine',
        description: 'services/auth Management API access (one-time tokens, users, passwords)',
      },
    }));

  const managementApi = (await api(endpoint, '/resources')).find(
    ({ indicator }) => indicator === 'https://default.logto.app/api'
  );
  if (!managementApi) {
    throw new Error('Logto Management API resource not found');
  }
  const allScope = (await api(endpoint, `/resources/${managementApi.id}/scopes`)).find(
    ({ name }) => name === 'all'
  );

  const roles = await api(endpoint, '/roles?page=1&page_size=100');
  const role =
    roles.find(({ name }) => name === 'services-auth-m2m') ??
    (await api(endpoint, '/roles', {
      method: 'POST',
      body: {
        name: 'services-auth-m2m',
        description: 'Management API access for the Silktide auth service',
        type: 'MachineToMachine',
        scopeIds: [allScope.id],
      },
    }));

  // Assigning an already-assigned app 422s; tolerate it for idempotency.
  await api(endpoint, `/roles/${role.id}/applications`, {
    method: 'POST',
    body: { applicationIds: [app.id] },
  }).catch((error) => {
    if (error.status !== 422) throw error;
  });

  return { ...app, secret: await appSecretOf(endpoint, app.id) };
};

const loadEmailTemplate = async (file) => {
  const raw = await readFile(new URL(`email-templates/${file}`, import.meta.url), 'utf8');
  return raw
    .replaceAll('{{ legal_entity_line }}', LEGAL_ENTITY_LINE)
    .replaceAll('{{ legal_trademark_holder }}', LEGAL_TRADEMARK_HOLDER);
};

const seedEmailTemplates = async (endpoint) => {
  const templates = await Promise.all(
    EMAIL_TEMPLATES.map(async ({ templateType, subject, file }) => ({
      languageTag: 'en',
      templateType,
      details: {
        subject,
        content: await loadEmailTemplate(file),
        contentType: 'text/html',
      },
    }))
  );

  await api(endpoint, '/email-templates', { method: 'PUT', body: { templates } });
};

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

    await configureSignInExperience(region.endpoint);
    console.log('  sign-in experience: email + password, Silktide branding, policies');

    await ensureEmailConnector(region.endpoint);
    await seedEmailTemplates(region.endpoint);
    console.log(
      `  email: SMTP -> ${SMTP_HOST}:${SMTP_PORT}, ${EMAIL_TEMPLATES.length} branded templates`
    );

    const m2mApp = await ensureM2mAccess(region.endpoint);
    console.log(`  m2m application:          ${m2mApp.id} (role services-auth-m2m)`);

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
      `LOGTO_${upper}_ENDPOINT=${region.publicEndpoint}`,
      `LOGTO_${upper}_APP_ID=${portalApp.id}`,
      `LOGTO_${upper}_APP_SECRET=${portalSecret}`
    );
    authServiceEnv.push(
      `LOGTO_${upper}_ENDPOINT=${region.publicEndpoint}`,
      `LOGTO_${upper}_APP_CLIENT_ID=${authApp.id}`,
      `LOGTO_${upper}_APP_CLIENT_SECRET=${authSecret}`,
      `LOGTO_${upper}_M2M_CLIENT_ID=${m2mApp.id}`,
      `LOGTO_${upper}_M2M_CLIENT_SECRET=${m2mApp.secret}`
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
  console.log('Caught emails (password reset, MFA): http://localhost:8025');
};

await main();
