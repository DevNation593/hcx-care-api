import { spawnSync } from 'node:child_process';
import { verifyPlatformRolePermissionsMigration } from '../prisma/verify-platform-role-permissions';

describe('platform role permission migration verifier', () => {
  it.each([
    'postgresql://postgres:postgres@localhost:5432/psic_clinic_dev',
    'postgresql://postgres:postgres@localhost:5432/psic_clinic_test',
    'postgresql://postgres:postgres@localhost:5432/psic_clinic_specialty_stage_test?options=-csearch_path%3Dpublic',
  ])('refuses an unsafe database target before any schema mutation', async (databaseUrl) => {
    await expect(verifyPlatformRolePermissionsMigration(databaseUrl)).rejects.toThrow(
      'Specialty stage requires the exact disposable database',
    );
  });

  it('refuses an unsafe URL through the npm entry point without exposing credentials', () => {
    const result = spawnSync(
      process.execPath,
      [process.env.npm_execpath!, 'run', '--silent', 'prisma:verify-platform-role-permissions'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          DATABASE_URL_TEST: 'postgresql://secret-user:secret-password@127.0.0.1:1/psic_clinic_dev',
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe('Specialty stage requires the exact disposable database');
    expect(result.stdout).not.toContain('secret');
  });
});
