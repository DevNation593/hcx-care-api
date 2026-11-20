import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORTHODONTIC_MODULE_KEYS } from '../prisma/audit-orthodontic-modules';
import {
  DENTISTRY_MODULE_KEYS_AT_CATALOG,
  verifyOrthodonticModulesMigration,
} from '../prisma/verify-orthodontic-modules-migration';
import { specialtyModuleKeys } from '../src/clinical-modules/clinical-module-registry';
import { ORTHODONTICS_MODULES } from '../src/clinical-modules/definitions/orthodontics';

describe('orthodontic modules migration verifier', () => {
  it('checks every orthodontic module the registry defines', () => {
    expect([...ORTHODONTIC_MODULE_KEYS].sort()).toEqual(
      ORTHODONTICS_MODULES.map(({ moduleKey }) => moduleKey).sort(),
    );
  });

  it('expects a dentistry created by the catalog migration to own every dentistry module', () => {
    const registry = specialtyModuleKeys('DENTISTRY');
    for (const moduleKey of DENTISTRY_MODULE_KEYS_AT_CATALOG) expect(registry).toContain(moduleKey);
    expect(DENTISTRY_MODULE_KEYS_AT_CATALOG).toEqual(
      expect.arrayContaining([
        'dentistry.odontogram',
        'dentistry.treatments',
        'dentistry.evolution',
      ]),
    );
  });

  it('links every dentistry module in the catalog migration', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20261120000000_orthodontics_dentistry_catalog/migration.sql',
      ),
      'utf8',
    );
    for (const moduleKey of DENTISTRY_MODULE_KEYS_AT_CATALOG) {
      expect(sql).toContain(`('DENTISTRY', '${moduleKey}')`);
    }
  });

  it.each([
    'postgresql://postgres:postgres@localhost:5432/psic_clinic_dev',
    'postgresql://postgres:postgres@localhost:5432/psic_clinic_test',
    'postgresql://postgres:postgres@localhost:5432/psic_clinic_specialty_stage_test?options=-csearch_path%3Dpublic',
  ])('refuses an unsafe database target before any schema mutation', async (databaseUrl) => {
    await expect(verifyOrthodonticModulesMigration(databaseUrl)).rejects.toThrow(
      'Specialty stage requires the exact disposable database',
    );
  });

  it('refuses an unsafe URL through the npm entry point without exposing credentials', () => {
    const result = spawnSync(
      process.execPath,
      [process.env.npm_execpath!, 'run', '--silent', 'prisma:verify-orthodontic-modules'],
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
