import { PrismaClient } from '@prisma/client';

/**
 * Check (default) or reconcile (`--reconcile`) the conversion of "RefreshToken"."token" to
 * sha256 hex made by migration 20261122000000_hash_refresh_tokens.
 *
 * The migration rewrites the rows that exist when it runs. An old API instance that keeps serving
 * afterwards (rolling deploy) inserts JWTs in clear text, and the new API answers 401 to them
 * because it looks tokens up by their hash. `prisma migrate deploy` does not apply a migration
 * twice, so running it again does not fix those rows. Run this after every old instance is gone:
 *
 *   npm run prisma:verify-refresh-token-hash                 read-only; exit code 1 if rows remain
 *   DATABASE_URL=... npm run prisma:verify-refresh-token-hash -- --reconcile
 *                                                            converts the remaining rows, then checks
 *
 * It never prints a token, a prefix or a hash: only counts, and the target as host, port and
 * database name (never the user, the password or the URL). Check that target before trusting
 * the result: a `.env` file is read in verify mode when DATABASE_URL is not in the environment.
 * `--reconcile` writes, so it requires DATABASE_URL in the environment and never reads `.env`.
 *
 * Exit codes: 0 all rows are hashes, 1 rows still not converted, 2 usage or runtime error. A
 * failure of the check after the reconcile commit exits 2 although the rewrite was saved: run the
 * verification again.
 */

/**
 * The criterion of the migration: a value of exactly 64 lowercase hex characters is already a
 * hash (a JWT always contains dots). Keep it identical to the `!~` predicate in the migration SQL;
 * `test/refresh-token-hash-migration.spec.ts` compares both.
 */
export const HASHED_TOKEN_PATTERN = '^[0-9a-f]{64}$';

/** Same conversion as the migration, applied to the rows that are not a hash yet. */
export const CONVERT_SQL = `UPDATE "RefreshToken"
SET "token" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token" !~ '${HASHED_TOKEN_PATTERN}'`;

/**
 * Limits of each interactive transaction. The UPDATE rewrites every remaining row, so a very
 * large table may need a longer `timeout`: raise it here (milliseconds) if the reconcile aborts.
 */
export const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

export type RefreshTokenHashStatus = {
  total: number;
  /** Rows that already hold a sha256 hex. */
  converted: number;
  /** Rows that hold anything else (a JWT in clear text written by an old instance). */
  unconverted: number;
  /** Unconverted rows still usable by their owner (not revoked, not expired): the ones that would 401. */
  unconvertedActive: number;
};

export type RefreshTokenHashReconciliation = {
  before: RefreshTokenHashStatus;
  /** Rows rewritten by this run. */
  reconciled: number;
  after: RefreshTokenHashStatus;
};

/** Where the script runs, without credentials. */
export type DatabaseTarget = {
  host: string;
  port: string;
  database: string;
  /** The `schema` query parameter, when the URL has one. */
  schema?: string;
  /** True when the URL carries a `host=` query parameter (a Unix socket); the path is not shown. */
  socket?: true;
  /** `env`: the process environment; `.env`: loaded from the .env file of the working directory. */
  source: 'env' | '.env';
};

/** True when there are rows that the API cannot look up. */
export function hasUnconvertedTokens(status: RefreshTokenHashStatus): boolean {
  return status.unconverted > 0;
}

const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const IPV6_HOST = /^\[[0-9A-Fa-f:.]+\]$/;
const DATABASE_NAME = /^[A-Za-z0-9_.$-]+$/;
const SCHEMA_NAME = /^[A-Za-z0-9_$-]+$/;

/**
 * Host, port and database of a connection URL, never the user, the password or the full query.
 *
 * A password with an unencoded `/`, `?` or `#` makes the WHATWG parser read part of it as host,
 * port or path, so a value that merely parses is not trusted: any shape that does not look like
 * `scheme://[user[:password]@]host[:port][/database]` yields `(unparseable)` instead.
 */
export function describeDatabaseTarget(
  url: string,
  source: DatabaseTarget['source'],
): DatabaseTarget {
  const unparseable: DatabaseTarget = {
    host: '(unparseable)',
    port: '(unknown)',
    database: '(unknown)',
    source,
  };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return unparseable;

    // In the original text the authority ends at the first `/`, `?` or `#`, and the credentials end
    // at the last `@` of the authority. An `@` after that first delimiter means the password holds
    // an unencoded delimiter, so what the parser calls host, port, path or query is part of it.
    const afterScheme = url.slice(url.indexOf('://') + 3);
    const delimiter = afterScheme.search(/[/?#]/);
    if (delimiter >= 0 && afterScheme.indexOf('@', delimiter) >= 0) return unparseable;
    if (afterScheme.includes('@') && !parsed.username && !parsed.password) return unparseable;
    for (const part of [parsed.pathname, parsed.search, parsed.hash]) {
      if (part.includes('@')) return unparseable;
    }
    if (parsed.pathname.includes(':')) return unparseable;

    const host = parsed.hostname;
    if (!host || !(HOSTNAME.test(host) || IPV6_HOST.test(host))) return unparseable;
    if (parsed.port !== '' && !(/^\d{1,5}$/.test(parsed.port) && Number(parsed.port) >= 1)) {
      return unparseable;
    }
    if (parsed.port !== '' && Number(parsed.port) > 65535) return unparseable;

    const path = parsed.pathname.replace(/^\//, '');
    if (path.includes('/')) return unparseable;
    const database = decodeURIComponent(path);
    if (database !== '' && !DATABASE_NAME.test(database)) return unparseable;

    const target: DatabaseTarget = {
      host,
      port: parsed.port || '5432',
      database: database || '(unknown)',
      source,
    };
    const schema = parsed.searchParams.get('schema');
    if (schema !== null) {
      if (!SCHEMA_NAME.test(schema)) return unparseable;
      target.schema = schema;
    }
    // `host=/some/dir` is a Unix socket directory; only that fact is shown, never the path.
    if (parsed.searchParams.get('host')?.startsWith('/')) target.socket = true;
    // Same order in the JSON whatever the URL looked like.
    return { ...target, source };
  } catch {
    return unparseable;
  }
}

function formatTarget(target: DatabaseTarget): string {
  const extras = [target.schema ? ` schema=${target.schema}` : '', target.socket ? ' socket' : ''];
  return `${target.host}:${target.port}/${target.database}${extras.join('')} (from ${target.source})`;
}

type CountRow = {
  total: bigint;
  converted: bigint;
  unconverted: bigint;
  unconvertedActive: bigint;
};

type Raw = { $queryRawUnsafe<T = unknown>(query: string): Promise<T> };

async function readStatus(tx: Raw): Promise<RefreshTokenHashStatus> {
  const [row] = await tx.$queryRawUnsafe<CountRow[]>(
    `SELECT COUNT(*)::bigint AS "total",
            COUNT(*) FILTER (WHERE "token" ~ '${HASHED_TOKEN_PATTERN}')::bigint AS "converted",
            COUNT(*) FILTER (WHERE "token" !~ '${HASHED_TOKEN_PATTERN}')::bigint AS "unconverted",
            COUNT(*) FILTER (
              WHERE "token" !~ '${HASHED_TOKEN_PATTERN}'
                AND NOT "isRevoked" AND "expiresAt" > (now() AT TIME ZONE 'utc')
            )::bigint AS "unconvertedActive"
     FROM "RefreshToken"`,
  );
  return {
    total: Number(row.total),
    converted: Number(row.converted),
    unconverted: Number(row.unconverted),
    unconvertedActive: Number(row.unconvertedActive),
  };
}

/** Read-only: counts the rows by state inside a READ ONLY transaction. */
export async function verifyRefreshTokenHashes(
  client: PrismaClient,
): Promise<RefreshTokenHashStatus> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return readStatus(tx);
  }, TRANSACTION_OPTIONS);
}

/**
 * Applies the migration's conversion to the rows that are still not a hash, in one transaction,
 * and verifies again afterwards. Idempotent: a second run finds nothing to change. The UPDATE
 * locks the rewritten rows until the commit.
 */
export async function reconcileRefreshTokenHashes(
  client: PrismaClient,
): Promise<RefreshTokenHashReconciliation> {
  const { before, reconciled } = await client.$transaction(async (tx) => {
    const before = await readStatus(tx);
    const reconciled = await tx.$executeRawUnsafe(CONVERT_SQL);
    return { before, reconciled };
  }, TRANSACTION_OPTIONS);
  // Separate read-only check after the commit: a late write by an old instance shows up here.
  const after = await verifyRefreshTokenHashes(client);
  return { before, reconciled, after };
}

export type CliOptions = { reconcile: boolean };

/** Rejects anything but `--reconcile`, so a typo never degrades silently to another mode. */
export function parseArgs(argv: string[]): CliOptions {
  const unknown = argv.filter((arg) => arg !== '--reconcile');
  if (unknown.length > 0) {
    throw new Error(`Unknown argument: ${unknown[0]}. The only option is --reconcile.`);
  }
  return { reconcile: argv.includes('--reconcile') };
}

/** Never includes the database message: it can quote the conflicting value of the token column. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('Unknown argument')) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : 'Error';
  return `The check failed (${name}${typeof code === 'string' ? ` ${code}` : ''}). No token value is printed; see the database logs.`;
}

/**
 * Finds the database URL. Verify mode falls back to the `.env` of the working directory (the
 * source of `prisma migrate deploy`), and says so; a `.env` that cannot be read is reported, not
 * ignored. Reconcile mode only trusts the process environment.
 */
function resolveDatabaseUrl(
  reconcile: boolean,
): { url: string; source: DatabaseTarget['source'] } | { error: string } {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, source: 'env' };
  if (reconcile) {
    return {
      error:
        'DATABASE_URL is not set in the environment: --reconcile writes, so it does not read .env. ' +
        'Set DATABASE_URL explicitly for this command. Nothing was changed.',
    };
  }
  if (typeof process.loadEnvFile !== 'function') {
    console.error(
      'Warning: this Node version cannot load .env (process.loadEnvFile needs Node 20.12+); only the environment is used.',
    );
  } else {
    try {
      process.loadEnvFile('.env');
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') {
        console.error('Warning: the .env file exists but could not be loaded; it was ignored.');
      }
    }
  }
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, source: '.env' };
  return { error: 'DATABASE_URL is not set (environment or .env): nothing was checked.' };
}

export async function main(argv: string[], client?: PrismaClient): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(describeError(error));
    return 2;
  }
  const resolved = resolveDatabaseUrl(options.reconcile);
  if ('error' in resolved) {
    console.error(resolved.error);
    return 2;
  }
  const target = describeDatabaseTarget(resolved.url, resolved.source);
  console.error(`Target database: ${formatTarget(target)}`);

  let prisma: PrismaClient | undefined = client;
  try {
    prisma ??= new PrismaClient();
    if (options.reconcile) {
      const result = await reconcileRefreshTokenHashes(prisma);
      console.log(JSON.stringify({ mode: 'reconcile', target, ...result }, null, 2));
      if (hasUnconvertedTokens(result.after)) {
        console.error(
          `${result.after.unconverted} row(s) are still not a hash on ${formatTarget(target)}: an old instance may still be writing.`,
        );
        return 1;
      }
      return 0;
    }
    const status = await verifyRefreshTokenHashes(prisma);
    console.log(JSON.stringify({ mode: 'verify', target, ...status }, null, 2));
    if (hasUnconvertedTokens(status)) {
      console.error(
        `${status.unconverted} refresh token row(s) on ${formatTarget(target)} are not a sha256 hash and the API answers 401 to them. ` +
          'Once no old instance is serving, re-run with --reconcile.',
      );
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(describeError(error));
    return 2;
  } finally {
    if (!client) await prisma?.$disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      // A failure outside the check (for example while disconnecting) is not "rows remain".
      process.exitCode = 2;
    });
}
