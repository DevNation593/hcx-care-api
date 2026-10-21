import { assertDemoSeedTarget } from '../prisma/seed';

describe('demo seed target', () => {
  it('refuses production and remote databases before deleting any data', () => {
    expect(() =>
      assertDemoSeedTarget('postgresql://u:p@db.supabase.co:5432/prod', 'development'),
    ).toThrow('solo se puede ejecutar en PostgreSQL local');
    expect(() =>
      assertDemoSeedTarget('postgresql://u:p@127.0.0.1:5432/test', 'production'),
    ).toThrow('solo se puede ejecutar en PostgreSQL local');
  });

  it('allows an explicit local database for demo work', () => {
    expect(() =>
      assertDemoSeedTarget('postgresql://u:p@127.0.0.1:5432/test', 'development'),
    ).not.toThrow();
  });
});
