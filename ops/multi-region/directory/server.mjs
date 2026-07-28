/**
 * Region directory.
 *
 * Maps a keyed hash of a sign-in identifier to the region that holds that
 * user's records. This is the only component that sits outside a region, so it
 * deliberately stores no readable personal data: identifiers arrive, are
 * HMAC'd, and the plaintext is discarded.
 *
 *   POST /resolve   {"identifier":"a@b.com"}                -> {"region":"eu"|null}
 *   PUT  /entries   {"identifier":"a@b.com","region":"eu"}     (admin token)
 *   GET  /entries                                              (admin token)
 *   GET  /health
 *
 * Backed by its own Postgres — the same engine as each region, but a separate
 * instance, so "core" and "regional" are different databases on different
 * hosts rather than different schemas in one.
 *
 * `pg` resolves from the Logto image's node_modules: the compose file mounts
 * this directory inside /etc/logto so Node's upward resolution finds it. That
 * keeps the harness free of its own image build.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import pg from 'pg';

const PORT = Number(process.env.PORT ?? 3300);
const HMAC_KEY = process.env.DIRECTORY_HMAC_KEY;
const ADMIN_TOKEN = process.env.DIRECTORY_ADMIN_TOKEN;
const DB_URL = process.env.DIRECTORY_DB_URL;

if (!HMAC_KEY || !ADMIN_TOKEN || !DB_URL) {
  console.error('DIRECTORY_HMAC_KEY, DIRECTORY_ADMIN_TOKEN and DIRECTORY_DB_URL are required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 10 });

/**
 * Normalization must match how Logto looks the identifier up, or a user
 * resolves to a region and then is not found there.
 * Email: `findUserByEmail` compares `lower(primary_email) = lower($1)`.
 */
const normalize = (identifier) => identifier.trim().toLowerCase();

/** Domain-separated so an email hash can never be replayed as another type. */
const hash = (identifier) =>
  createHmac('sha256', HMAC_KEY).update(`email${normalize(identifier)}`).digest('hex');

const migrate = async () => {
  await pool.query(`
    create table if not exists regions (
      id           text primary key,
      display_name text not null,
      created_at   timestamptz not null default now()
    );

    create table if not exists region_directory (
      identifier_hash char(64) primary key,
      region_id       text not null references regions (id),
      created_at      timestamptz not null default now()
    );

    create index if not exists region_directory__region on region_directory (region_id);
  `);

  // The FK above is the point of using a real database here: an entry cannot
  // name a region that does not exist.
  await pool.query(`
    insert into regions (id, display_name) values ('eu', 'European Union'), ('us', 'United States')
    on conflict (id) do nothing;
  `);
};

const waitForDatabase = async () => {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await pool.query('select 1');
      return;
    } catch (error) {
      if (attempt === 60) throw error;
      if (attempt === 1 || attempt % 10 === 0) {
        console.log(`directory: waiting for postgres (${attempt}/60)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

const readJson = (request) =>
  new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      // A resolve payload is one identifier; anything larger is not a real client.
      if (body.length > 4096) reject(new Error('payload too large'));
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    request.on('error', reject);
  });

const send = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
};

const isAdmin = (request) => {
  const provided = (request.headers.authorization ?? '').replace(/^Bearer /, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      const { rows } = await pool.query('select count(*)::int as count from region_directory');
      return send(response, 200, { ok: true, entries: rows[0].count });
    }

    /**
     * Resolve is an account-existence oracle by construction. It always answers
     * 200 with the same shape so a hit and a miss are indistinguishable to a
     * caller timing responses or diffing status codes. A production deployment
     * must also rate limit this per IP and globally.
     */
    if (request.method === 'POST' && url.pathname === '/resolve') {
      const { identifier } = await readJson(request);
      if (typeof identifier !== 'string' || !identifier) {
        return send(response, 200, { region: null });
      }

      const { rows } = await pool.query(
        'select region_id from region_directory where identifier_hash = $1',
        [hash(identifier)]
      );

      return send(response, 200, { region: rows[0]?.region_id ?? null });
    }

    if (request.method === 'PUT' && url.pathname === '/entries') {
      if (!isAdmin(request)) return send(response, 401, { error: 'unauthorized' });

      const { identifier, region } = await readJson(request);
      if (typeof identifier !== 'string' || typeof region !== 'string') {
        return send(response, 400, { error: 'identifier and region are required' });
      }

      const key = hash(identifier);

      // Repointing an entry is a residency change: it must be an explicit,
      // audited migration, never a side effect of re-running a seed. The
      // insert is a no-op on conflict so we can report the existing value.
      const { rows } = await pool.query(
        `insert into region_directory (identifier_hash, region_id) values ($1, $2)
         on conflict (identifier_hash) do nothing
         returning region_id`,
        [key, region]
      );

      if (rows[0]) {
        return send(response, 201, { region: rows[0].region_id });
      }

      const { rows: existing } = await pool.query(
        'select region_id from region_directory where identifier_hash = $1',
        [key]
      );

      if (existing[0]?.region_id === region) {
        return send(response, 200, { region });
      }

      return send(response, 409, { error: 'already assigned', region: existing[0]?.region_id });
    }

    if (request.method === 'GET' && url.pathname === '/entries') {
      if (!isAdmin(request)) return send(response, 401, { error: 'unauthorized' });

      // Hashes only -- the directory cannot reveal who these are.
      const { rows } = await pool.query(
        'select identifier_hash, region_id from region_directory order by created_at'
      );

      return send(response, 200, {
        entries: Object.fromEntries(rows.map((row) => [row.identifier_hash.trim(), row.region_id])),
      });
    }

    return send(response, 404, { error: 'not found' });
  } catch (error) {
    console.error('directory:', error.message);
    // A foreign-key violation means an unknown region was supplied.
    const status = error.code === '23503' ? 400 : 500;
    return send(response, status, { error: error.message });
  }
});

await waitForDatabase();
await migrate();
server.listen(PORT, () => console.log(`directory: listening on ${PORT}`));
