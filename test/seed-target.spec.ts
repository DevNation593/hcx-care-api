import { demoSeedTarget } from '../prisma/seed';

describe('demo seed target', () => {
  it('runs on the database of DATABASE_URL, production included, with no other variable', () => {
    expect(
      demoSeedTarget('postgresql://u:p@AWS-1-us-east-1.pooler.supabase.com:5432/postgres'),
    ).toBe('aws-1-us-east-1.pooler.supabase.com');
    expect(demoSeedTarget('postgresql://u:p@127.0.0.1:5432/test')).toBe('127.0.0.1');
  });

  it('refuses a missing or non-PostgreSQL url', () => {
    expect(() => demoSeedTarget(undefined)).toThrow('DATABASE_URL de PostgreSQL válido');
    expect(() => demoSeedTarget('mysql://u:p@localhost/x')).toThrow(
      'DATABASE_URL de PostgreSQL válido',
    );
  });
});
