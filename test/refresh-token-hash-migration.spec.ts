import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  CONVERT_SQL,
  HASHED_TOKEN_PATTERN,
  TRANSACTION_OPTIONS,
  describeDatabaseTarget,
  hasUnconvertedTokens,
  main,
  parseArgs,
} from '../prisma/verify-refresh-token-hash-migration';

const migrationSql = readFileSync(
  join(
    __dirname,
    '..',
    'prisma',
    'migrations',
    '20261122000000_hash_refresh_tokens',
    'migration.sql',
  ),
  'utf8',
);
const normalize = (sql: string) =>
  sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim();

const HASH = createHash('sha256').update('a.b.c', 'utf8').digest('hex');
const URL_WITH_CREDENTIALS =
  'postgresql://dbuser:s3cr3tpw@db.example.test:6543/clinic?schema=public';

describe('refresh token hash migration check', () => {
  it('uses the exact conversion SQL of the migration', () => {
    expect(normalize(CONVERT_SQL)).toBe(normalize(migrationSql));
    expect(migrationSql).toContain(`'${HASHED_TOKEN_PATTERN}'`);
  });

  it('flags unconverted rows only when there are some', () => {
    const clean = { total: 2, converted: 2, unconverted: 0, unconvertedActive: 0 };
    expect(hasUnconvertedTokens(clean)).toBe(false);
    expect(hasUnconvertedTokens({ ...clean, converted: 1, unconverted: 1 })).toBe(true);
  });

  it('accepts only --reconcile', () => {
    expect(parseArgs([])).toEqual({ reconcile: false });
    expect(parseArgs(['--reconcile'])).toEqual({ reconcile: true });
    expect(() => parseArgs(['--reconcille'])).toThrow('Unknown argument');
  });

  it('describes the target as host, port, database and schema, without credentials', () => {
    expect(describeDatabaseTarget(URL_WITH_CREDENTIALS, 'env')).toEqual({
      host: 'db.example.test',
      port: '6543',
      database: 'clinic',
      schema: 'public',
      source: 'env',
    });
    expect(describeDatabaseTarget('postgresql://u:p@localhost/x', '.env')).toEqual({
      host: 'localhost',
      port: '5432',
      database: 'x',
      source: '.env',
    });
    expect(describeDatabaseTarget('postgres://u:p@[::1]:5433/db', 'env')).toMatchObject({
      host: '[::1]',
      port: '5433',
      database: 'db',
    });
    expect(describeDatabaseTarget('postgresql://u:p@localhost', 'env')).toMatchObject({
      host: 'localhost',
      database: '(unknown)',
    });
  });

  it('says only that a socket is used, never its path', () => {
    const target = describeDatabaseTarget(
      'postgresql://dbuser:s3cr3tpw@localhost/clinic?host=/cloudsql/secret-project:region:db&schema=app',
      'env',
    );
    expect(target).toEqual({
      host: 'localhost',
      port: '5432',
      database: 'clinic',
      schema: 'app',
      socket: true,
      source: 'env',
    });
    expect(JSON.stringify(target)).not.toContain('cloudsql');
  });

  it('flags a socket only when host= is a directory path', () => {
    const named = describeDatabaseTarget(
      'postgresql://u:p@localhost/clinic?host=pg.internal',
      'env',
    );
    expect(named).not.toHaveProperty('socket');
    expect(JSON.stringify(named)).not.toContain('pg.internal');
  });

  it('shows the host, port and database of a Supabase pooler URL and nothing else of it', () => {
    const target = describeDatabaseTarget(
      'postgres://postgres.abcdefgh:s3cret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1',
      'env',
    );
    expect(target).toEqual({
      host: 'aws-0-us-east-1.pooler.supabase.com',
      port: '6543',
      database: 'postgres',
      source: 'env',
    });
    const serialized = JSON.stringify(target);
    for (const hidden of ['postgres.abcdefgh', 's3cret', 'pgbouncer', 'connection_limit']) {
      expect(serialized).not.toContain(hidden);
    }
  });

  // Each entry: the URL and the pieces of it that must never reach the output.
  const hostile: [string, string, string[]][] = [
    [
      'unencoded slash after digits',
      'postgresql://dbuser:1234/abc@db.host/prod',
      ['dbuser', '1234', 'abc'],
    ],
    ['unencoded slash', 'postgresql://dbuser:pa/ss@db.host/prod', ['dbuser', 'pa/ss']],
    [
      'unencoded slash, digits, port',
      'postgresql://dbuser:12/ss@db.host:5432/prod',
      ['dbuser', '12/ss'],
    ],
    ['unencoded question mark', 'postgresql://dbuser:12?x@db.host/prod', ['dbuser', '12?x']],
    ['unencoded hash', 'postgresql://dbuser:12#x@db.host/prod', ['dbuser', '12#x']],
    [
      'unencoded at sign, then colon and question mark',
      'postgresql://dbuser:a@secreto:123?x@db.host/prod',
      ['dbuser', 'secreto', '123', 'a@secreto', '?x'],
    ],
    [
      'unencoded at sign, then hash',
      'postgresql://dbuser:hunter@clave#x@db.host/prod',
      ['dbuser', 'hunter', 'clave', '#x'],
    ],
    ['unencoded at sign', 'postgresql://dbuser:p@ss@db.host/prod', ['dbuser', 'p@ss', 'p%40ss']],
    ['unencoded colon', 'postgresql://dbuser:pa:ss@db.host/prod', ['dbuser', 'pa:ss']],
    ['unencoded percent', 'postgresql://dbuser:100%@db.host/prod', ['dbuser', '100%']],
    ['invalid percent escape', 'postgresql://dbuser:%zz%@db.host/prod', ['dbuser', '%zz']],
    [
      'encoded delimiters',
      'postgresql://dbuser:p%2Fss%3Fw%23rd%40x%3A%25@db.host/prod',
      ['dbuser', 'p%2Fss', 'p/ss', 'w#rd'],
    ],
    [
      'IPv6 host with credentials',
      'postgresql://dbuser:s3cr3t@[::1]:5432/prod',
      ['dbuser', 's3cr3t'],
    ],
    ['credentials, no database', 'postgresql://dbuser:s3cr3t@db.host', ['dbuser', 's3cr3t']],
    ['port out of range', 'postgresql://dbuser:s3cr3t@db.host:99999/prod', ['dbuser', 's3cr3t']],
    ['user only, digits', 'postgresql://dbuser12:34/x@db.host/prod', ['dbuser12', '34/x']],
    ['other scheme', 'http://dbuser:s3cr3t@db.host/prod', ['dbuser', 's3cr3t']],
    ['not a url', 'dbuser:s3cr3t@db.host/prod', ['dbuser', 's3cr3t']],
    ['password in the schema parameter', 'postgresql://db.host/prod?schema=s3cr3t/x', ['s3cr3t']],
  ];

  it.each(hostile)('never prints credentials: %s', (_name, url, secrets) => {
    const serialized = JSON.stringify(describeDatabaseTarget(url, 'env'));
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });

  it('answers (unparseable) when the URL splits its credentials into host, port or path', () => {
    for (const url of [
      'postgresql://dbuser:1234/abc@db.host/prod',
      'postgresql://dbuser:12?x@db.host/prod',
      'postgresql://dbuser:12#x@db.host/prod',
      'postgresql://dbuser:a@secreto:123?x@db.host/prod',
      'postgresql://dbuser:hunter@clave#x@db.host/prod',
      'postgresql://dbuser:pa/ss@db.host/prod',
      'postgresql://db.host:5432x/prod',
      'postgresql://db.host:99999/prod',
      'postgresql://db.host/prod/extra',
      'postgresql://db.host/pro d',
      'http://db.host/prod',
      'not a url',
    ]) {
      expect(describeDatabaseTarget(url, 'env')).toEqual({
        host: '(unparseable)',
        port: '(unknown)',
        database: '(unknown)',
        source: 'env',
      });
    }
  });

  it('exits 2, not 1, when the database cannot be reached, and prints no credentials', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        join(__dirname, '..', 'prisma', 'verify-refresh-token-hash-migration.ts'),
      ],
      {
        cwd: join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: 'postgresql://dbuser:s3cr3tpw@127.0.0.1:9/nowhere' },
        encoding: 'utf8',
        timeout: 90000,
      },
    );
    const output = `${result.stdout}
${result.stderr}`;
    expect(result.status).toBe(2);
    expect(output).toContain('127.0.0.1:9/nowhere (from env)');
    expect(output).not.toContain('s3cr3tpw');
  }, 120000);

  describe('main', () => {
    const originalUrl = process.env.DATABASE_URL;
    const originalLoadEnvFile = process.loadEnvFile;
    let log: jest.SpyInstance;
    let error: jest.SpyInstance;

    function fakeClient(
      counts: Record<string, bigint>[],
      statements: string[],
      transactionOptions: unknown[] = [],
    ) {
      let reads = 0;
      const tx = {
        $executeRawUnsafe: jest.fn(async (sql: string) => {
          statements.push(sql);
          return 2;
        }),
        $queryRawUnsafe: jest.fn(async (sql: string) => {
          statements.push(sql);
          return [counts[Math.min(reads++, counts.length - 1)]];
        }),
      };
      return {
        $transaction: async (fn: (t: typeof tx) => unknown, options?: unknown) => {
          transactionOptions.push(options);
          return fn(tx);
        },
        $disconnect: jest.fn(),
      } as unknown as PrismaClient;
    }
    const row = (total: number, converted: number) => ({
      total: BigInt(total),
      converted: BigInt(converted),
      unconverted: BigInt(total - converted),
      unconvertedActive: BigInt(total - converted),
    });
    const printed = () => [...log.mock.calls, ...error.mock.calls].flat().join('\n');

    beforeEach(() => {
      log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      process.loadEnvFile = originalLoadEnvFile;
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    });

    it('fails clearly without DATABASE_URL and never touches the database', async () => {
      delete process.env.DATABASE_URL;
      const loadEnvFile = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);
      const statements: string[] = [];
      const client = fakeClient([row(1, 1)], statements);

      expect(await main([], client)).toBe(2);
      expect(loadEnvFile).toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(printed()).toContain('DATABASE_URL is not set');
    });

    it('reports where it runs, without credentials, in the JSON and the messages', async () => {
      process.env.DATABASE_URL = URL_WITH_CREDENTIALS;

      expect(await main([], fakeClient([row(5, 3)], []))).toBe(1);

      expect(JSON.parse(log.mock.calls[0][0]).target).toEqual({
        host: 'db.example.test',
        port: '6543',
        database: 'clinic',
        schema: 'public',
        source: 'env',
      });
      expect(printed()).toContain('db.example.test:6543/clinic schema=public (from env)');
      expect(printed()).not.toContain('s3cr3tpw');
      expect(printed()).not.toContain('dbuser');
    });

    it('prints no credentials either for a URL whose password has an unencoded slash', async () => {
      process.env.DATABASE_URL = 'postgresql://dbuser:1234/abc@db.host/prod';

      await main([], fakeClient([row(5, 3)], []));

      expect(JSON.parse(log.mock.calls[0][0]).target.host).toBe('(unparseable)');
      expect(printed()).not.toContain('dbuser');
      expect(printed()).not.toContain('1234');
      expect(printed()).not.toContain('abc');
    });

    it('reports a target loaded from .env as such', async () => {
      delete process.env.DATABASE_URL;
      jest.spyOn(process, 'loadEnvFile').mockImplementation(() => {
        process.env.DATABASE_URL = URL_WITH_CREDENTIALS;
      });

      expect(await main([], fakeClient([row(2, 2)], []))).toBe(0);

      expect(JSON.parse(log.mock.calls[0][0]).target.source).toBe('.env');
      expect(printed()).toContain('(from .env)');
      expect(printed()).not.toContain('s3cr3tpw');
    });

    it('warns instead of silently skipping .env when Node cannot load it', async () => {
      delete process.env.DATABASE_URL;
      (process as { loadEnvFile?: unknown }).loadEnvFile = undefined;

      expect(await main([], fakeClient([row(1, 1)], []))).toBe(2);

      expect(printed()).toContain('Warning: this Node version cannot load .env');
    });

    it('warns when .env exists but fails to load, and stays quiet when it is just absent', async () => {
      delete process.env.DATABASE_URL;
      const loader = jest.spyOn(process, 'loadEnvFile');

      loader.mockImplementationOnce(() => {
        throw Object.assign(new Error('boom with a secret value'), { code: 'ENOENT' });
      });
      expect(await main([], fakeClient([row(1, 1)], []))).toBe(2);
      expect(printed()).not.toContain('Warning');

      error.mockClear();
      loader.mockImplementationOnce(() => {
        throw new Error('boom with a secret value');
      });
      expect(await main([], fakeClient([row(1, 1)], []))).toBe(2);
      expect(printed()).toContain('could not be loaded');
      expect(printed()).not.toContain('secret value');
    });

    it('--reconcile requires DATABASE_URL in the environment and never reads .env', async () => {
      delete process.env.DATABASE_URL;
      const loader = jest.spyOn(process, 'loadEnvFile').mockImplementation(() => {
        process.env.DATABASE_URL = URL_WITH_CREDENTIALS;
      });
      const statements: string[] = [];

      expect(await main(['--reconcile'], fakeClient([row(5, 3)], statements))).toBe(2);

      expect(loader).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
      expect(printed()).toContain('--reconcile writes');
    });

    it('fails on an unknown argument before connecting', async () => {
      process.env.DATABASE_URL = URL_WITH_CREDENTIALS;
      const statements: string[] = [];
      expect(await main(['--fix'], fakeClient([row(1, 1)], statements))).toBe(2);
      expect(statements).toEqual([]);
    });

    it('verifies read-only: READ ONLY transaction, no write, exit 1 when rows remain', async () => {
      process.env.DATABASE_URL = URL_WITH_CREDENTIALS;
      const statements: string[] = [];
      const options: unknown[] = [];

      expect(await main([], fakeClient([row(5, 3)], statements, options))).toBe(1);

      expect(statements[0]).toBe('SET TRANSACTION READ ONLY');
      expect(statements.some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
      expect(options).toEqual([TRANSACTION_OPTIONS]);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        mode: 'verify',
        total: 5,
        converted: 3,
        unconverted: 2,
        unconvertedActive: 2,
      });
    });

    it('verifies a clean table with exit 0', async () => {
      process.env.DATABASE_URL = URL_WITH_CREDENTIALS;
      expect(await main([], fakeClient([row(4, 4)], []))).toBe(0);
    });

    it('reconciles in one transaction with the migration SQL, then checks again', async () => {
      process.env.DATABASE_URL = URL_WITH_CREDENTIALS;
      const statements: string[] = [];
      const options: unknown[] = [];

      const code = await main(
        ['--reconcile'],
        fakeClient([row(5, 3), row(5, 5)], statements, options),
      );

      expect(code).toBe(0);
      expect(statements).toContain(CONVERT_SQL);
      // Both transactions (rewrite and final check) carry the explicit limits.
      expect(options).toEqual([TRANSACTION_OPTIONS, TRANSACTION_OPTIONS]);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        mode: 'reconcile',
        target: { host: 'db.example.test', database: 'clinic', source: 'env' },
        reconciled: 2,
        before: { unconverted: 2 },
        after: { total: 5, converted: 5, unconverted: 0 },
      });
    });

    it('exits 1 when a row appears again between the rewrite and the final check', async () => {
      process.env.DATABASE_URL = URL_WITH_CREDENTIALS;
      const code = await main(['--reconcile'], fakeClient([row(5, 3), row(6, 5)], []));
      expect(code).toBe(1);
    });

    it('does not print the database message of a failure (it can quote a token column value)', async () => {
      process.env.DATABASE_URL = URL_WITH_CREDENTIALS;
      const leaky = Object.assign(new Error(`Key (token)=(${HASH}) already exists`), {
        code: 'P2010',
      });
      const client = {
        $transaction: async () => {
          throw leaky;
        },
        $disconnect: jest.fn(),
      } as unknown as PrismaClient;

      expect(await main(['--reconcile'], client)).toBe(2);

      expect(printed()).toContain('P2010');
      expect(printed()).not.toContain(HASH);
    });
  });
});
