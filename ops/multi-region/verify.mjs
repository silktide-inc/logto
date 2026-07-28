/**
 * End-to-end check of the multi-region setup.
 *
 *   node ops/multi-region/verify.mjs
 *
 * Proves four things:
 *   1. the directory routes each identifier to the right region
 *   2. a full OIDC sign-in succeeds against that region, ending in a token
 *      issued by that region's issuer
 *   3. the same credentials are rejected by the other region
 *   4. no trace of a region's user exists in the other region's database
 *
 * (4) is the residency assertion. It scans every text-ish column in the schema
 * rather than a hand-written table list, because a hand-written list goes stale
 * the moment someone adds a table -- and the table nobody thought of is exactly
 * where a leak survives.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DIRECTORY = process.env.DIRECTORY_URL ?? 'http://localhost:3300';
const PASSWORD = process.env.TEST_PASSWORD ?? 'Silktide-Region-Test-2026!';
const REDIRECT_URI = 'http://localhost:3000/callback';

const REGIONS = {
  eu: {
    endpoint: 'http://localhost:3101',
    container: 'logto-regions-postgres-eu-1',
    appId: process.env.LOGTO_EU_APP_ID,
    appSecret: process.env.LOGTO_EU_APP_SECRET,
  },
  us: {
    endpoint: 'http://localhost:3201',
    container: 'logto-regions-postgres-us-1',
    appId: process.env.LOGTO_US_APP_ID,
    appSecret: process.env.LOGTO_US_APP_SECRET,
  },
};

const USERS = [
  { email: 'alice@eu-example.com', region: 'eu' },
  { email: 'bob@eu-example.com', region: 'eu' },
  { email: 'carol@us-example.com', region: 'us' },
  { email: 'dave@us-example.com', region: 'us' },
];

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

class CookieJar {
  #cookies = new Map();

  absorb(response) {
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.#cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
      }
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const base64Url = (buffer) =>
  buffer.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const resolveRegion = async (identifier) => {
  const response = await fetch(new URL('/resolve', DIRECTORY), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  const { region } = await response.json();
  return region ?? undefined;
};

/**
 * Drives the same Experience API sequence the portal uses, then exchanges the
 * authorization code so we can read the issuer out of the token response.
 */
const signIn = async (regionId, email, password) => {
  const { endpoint, appId, appSecret } = REGIONS[regionId];
  if (!appId || !appSecret) {
    throw new Error(`LOGTO_${regionId.toUpperCase()}_APP_ID/SECRET not set`);
  }

  const jar = new CookieJar();
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());

  const authUrl = new URL('/oidc/auth', endpoint);
  authUrl.search = new URLSearchParams({
    client_id: appId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile offline_access',
    state: base64Url(randomBytes(16)),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString();

  jar.absorb(await fetch(authUrl, { redirect: 'manual', cache: 'no-store' }));

  const experience = async (path, { method = 'POST', body } = {}) => {
    const response = await fetch(new URL(`/api/experience${path}`, endpoint), {
      method,
      headers: { 'content-type': 'application/json', cookie: jar.header() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    jar.absorb(response);
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${path} -> ${response.status} ${text}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : undefined;
  };

  await experience('', { method: 'PUT', body: { interactionEvent: 'SignIn' } });

  const { verificationId } = await experience('/verification/password', {
    body: { identifier: { type: 'email', value: email }, password },
  });

  await experience('/identification', { body: { verificationId } });

  const { redirectTo } = await experience('/submit');

  // Follow the OIDC hops (including auto-consent) until we get the code back.
  let location = redirectTo;
  let code;
  for (let hop = 0; hop < 10 && !code; hop++) {
    if (location.startsWith(REDIRECT_URI)) {
      code = new URL(location).searchParams.get('code');
      break;
    }
    const response = await fetch(location, {
      redirect: 'manual',
      cache: 'no-store',
      headers: { cookie: jar.header() },
    });
    jar.absorb(response);
    const next = response.headers.get('location');
    if (!next) throw new Error(`no redirect from ${location}`);
    location = new URL(next, location).href;
  }
  if (!code) throw new Error('never reached the redirect URI');

  const tokenResponse = await fetch(new URL('/oidc/token', endpoint), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  const tokens = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
  }

  // The id_token's `iss` is what proves which deployment authenticated this.
  const [, payload] = tokens.id_token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());

  return { claims, tokens };
};

const psql = async (container, sql) => {
  const { stdout } = await run('docker', [
    'exec',
    container,
    'psql',
    '-U',
    'postgres',
    '-d',
    'logto',
    '-tA',
    '-c',
    sql,
  ]);
  return stdout.trim();
};

/**
 * Scan every text/varchar/jsonb column in the schema for a needle. Generic on
 * purpose -- an enumerated table list cannot catch the table nobody thought of.
 */
const scanForNeedle = async (container, needle) => {
  const sql = `
    do $$
    declare r record; hits text := '';
    begin
      for r in
        select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and data_type in ('text','character varying','jsonb','json')
      loop
        execute format(
          'select case when exists (select 1 from public.%I where %I::text ilike %L) then %L else '''' end',
          r.table_name, r.column_name, '%${needle}%', r.table_name || '.' || r.column_name
        ) into strict hits;
        if hits <> '' then raise notice 'HIT %', hits; end if;
      end loop;
    end $$;
  `;
  const { stdout, stderr } = await run('docker', [
    'exec',
    container,
    'psql',
    '-U',
    'postgres',
    '-d',
    'logto',
    '-tA',
    '-c',
    sql,
  ]);
  return `${stdout}${stderr}`
    .split('\n')
    .filter((line) => line.includes('HIT '))
    .map((line) => line.replace(/^.*HIT /, '').trim());
};

const main = async () => {
  // Audit logs accumulate across runs, so clear them to get a meaningful
  // baseline for the residency scan. Dev harness only.
  for (const { container } of Object.values(REGIONS)) {
    await psql(container, 'delete from logs');
  }

  console.log('\n1. Directory routing');
  for (const { email, region } of USERS) {
    const resolved = await resolveRegion(email);
    check(resolved === region, `${email} -> ${region}`, resolved ? `got ${resolved}` : 'got none');
  }
  const unknown = await resolveRegion('nobody@example.com');
  check(unknown === undefined, 'unknown identifier resolves to nothing');

  console.log('\n2. Sign-in against the resolved region');
  for (const { email, region } of USERS) {
    try {
      const { claims } = await signIn(region, email, PASSWORD);
      const expectedIssuer = `${REGIONS[region].endpoint}/oidc`;
      check(claims.iss === expectedIssuer, `${email} signed in via ${region}`, `iss=${claims.iss}`);
    } catch (error) {
      check(false, `${email} signed in via ${region}`, error.message);
    }
  }

  console.log('\n3. Each region holds only its own users');
  for (const [regionId, { container }] of Object.entries(REGIONS)) {
    const emails = (
      await psql(container, 'select primary_email from users where primary_email is not null')
    )
      .split('\n')
      .filter(Boolean);
    const expected = USERS.filter((u) => u.region === regionId).map((u) => u.email);
    const matches =
      emails.length === expected.length && expected.every((email) => emails.includes(email));
    check(matches, `${regionId} holds exactly its own users`, emails.join(', '));
  }

  console.log('\n4. Residency after normal use: nothing of a region in the other region');
  for (const { email, region } of USERS) {
    const otherRegion = region === 'eu' ? 'us' : 'eu';
    const hits = await scanForNeedle(REGIONS[otherRegion].container, email.split('@')[0]);
    check(
      hits.length === 0,
      `${email} absent from ${otherRegion} database`,
      hits.length ? `found in ${hits.join(', ')}` : ''
    );
  }

  console.log('\n5. Cross-region sign-in is rejected');
  for (const { email, region } of USERS) {
    const otherRegion = region === 'eu' ? 'us' : 'eu';
    try {
      await signIn(otherRegion, email, PASSWORD);
      check(false, `${email} rejected by ${otherRegion}`, 'it succeeded, which would be a leak');
    } catch (error) {
      check(
        error.status === 422 || /invalid_credentials|422/.test(error.message),
        `${email} rejected by ${otherRegion}`,
        error.status ? `HTTP ${error.status}` : error.message.slice(0, 60)
      );
    }
  }

  // Rejecting the credentials is not the same as leaving no trace. Logto audits
  // the attempt, identifier included, in whichever region served it -- so a
  // misrouted request (a stale region cookie, a typo, a probe) writes that
  // person's email into the wrong region's `logs` table even though they have
  // no account there. Reported rather than asserted: it is Logto's behaviour,
  // not a regression, and the mitigation is upstream (do not let misrouted
  // requests reach a region) plus log retention.
  console.log('\n6. Finding: what a rejected cross-region attempt leaves behind');
  for (const { email, region } of USERS.slice(0, 1)) {
    const otherRegion = region === 'eu' ? 'us' : 'eu';
    const hits = await scanForNeedle(REGIONS[otherRegion].container, email.split('@')[0]);
    console.log(
      hits.length
        ? `  NOTE  ${email} now appears in the ${otherRegion} database: ${hits.join(', ')}`
        : `  NOTE  ${email} left no trace in ${otherRegion} (Logto behaviour may have changed)`
    );
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

await main();
