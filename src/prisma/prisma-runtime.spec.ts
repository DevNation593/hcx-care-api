import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { RlsContextService } from './rls-context.service';

jest.mock('@prisma/client', () => ({ PrismaClient: jest.fn() }));

describe('Prisma runtime connection configuration', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalVercel = process.env.VERCEL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VERCEL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  });

  function clientOptions() {
    new PrismaService(new RlsContextService());
    return (PrismaClient as unknown as jest.Mock).mock.calls.at(-1)[0] ?? {};
  }

  function runtimeUrl() {
    const configured = clientOptions().datasources?.db?.url;
    expect(configured).toEqual(expect.any(String));
    return new URL(configured);
  }

  it.each(['5432', '6543', ''])(
    'uses Supabase transaction pooling on Vercel when the configured port is %s',
    (port) => {
      process.env.VERCEL = '1';
      process.env.DATABASE_URL = `postgresql://clinic:encoded%40password@aws-1-us-east-1.pooler.supabase.com${port ? `:${port}` : ''}/postgres?schema=public&sslmode=require`;

      const url = runtimeUrl();

      expect(url.port).toBe('6543');
      expect(url.searchParams.get('pgbouncer')).toBe('true');
      expect(url.searchParams.get('connection_limit')).toBe('1');
      expect(url.searchParams.get('schema')).toBe('public');
      expect(url.searchParams.get('sslmode')).toBe('require');
      expect(url.username).toBe('clinic');
      expect(url.password).toBe('encoded%40password');
      expect(url.pathname).toBe('/postgres');
    },
  );

  it('preserves an explicit connection limit and unrelated connection parameters', () => {
    process.env.VERCEL = '1';
    process.env.DATABASE_URL =
      'postgresql://clinic:password@aws-1-us-east-1.pooler.supabase.com:6543/postgres?connection_limit=3&pool_timeout=20';

    const url = runtimeUrl();

    expect(url.searchParams.get('connection_limit')).toBe('3');
    expect(url.searchParams.get('pool_timeout')).toBe('20');
    expect(url.searchParams.get('pgbouncer')).toBe('true');
  });

  it('limits other PostgreSQL connections on Vercel without changing their host or port', () => {
    process.env.VERCEL = '1';
    process.env.DATABASE_URL = 'postgres://clinic:password@database.example.com:5432/clinic';

    const url = runtimeUrl();

    expect(url.hostname).toBe('database.example.com');
    expect(url.port).toBe('5432');
    expect(url.searchParams.get('connection_limit')).toBe('1');
    expect(url.searchParams.has('pgbouncer')).toBe(false);
  });

  it('leaves local and migration connections at their configured defaults', () => {
    process.env.DATABASE_URL =
      'postgresql://clinic:password@aws-1-us-east-1.pooler.supabase.com:5432/postgres';

    expect(clientOptions()).toEqual({});
  });

  it.each([undefined, 'not-a-database-url', 'prisma://accelerate.example.com/?api_key=test'])(
    'leaves missing or unsupported database URLs to Prisma validation: %s',
    (url) => {
      process.env.VERCEL = '1';
      if (url !== undefined) process.env.DATABASE_URL = url;

      expect(clientOptions()).toEqual({});
    },
  );
});
