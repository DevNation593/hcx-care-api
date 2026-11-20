import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { assertSpecialtyStageDatabaseSafety } from '../test/helpers/assert-e2e-database';
import {
  auditOrthodonticModules,
  ORTHODONTIC_MODULE_KEYS,
  OrthodonticModulesAudit,
} from './audit-orthodontic-modules';

const targetMigration = '20261119000000_orthodontics_modules';
const schemaPattern = /^orthodontic_modules_[a-f0-9]{16}$/;
const temporaryPrefix = 'orthodontic-modules-migration-';

type TenantModuleRow = { tenantId: string; moduleKey: string; enabled: boolean };

function clientFor(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

function urlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

function deploy(schemaPath: string, databaseUrl: string): void {
  const cli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: join(schemaPath, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.error) throw new Error(`Prisma migration process failed: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    throw new Error(
      `Migration deploy failed: ${output
        .replace(/(postgres(?:ql)?:\/\/)[^@\s/]*@/gi, '$1***@')
        .trim()
        .slice(-2000)}`,
    );
  }
}

function copyMigrations(destination: string, includeTarget: boolean): void {
  const source = join(__dirname, 'migrations');
  const target = join(destination, 'migrations');
  mkdirSync(target, { recursive: true });
  copyFileSync(join(source, 'migration_lock.toml'), join(target, 'migration_lock.toml'));
  for (const name of readdirSync(source)
    .filter(
      (item) =>
        /^\d+_/.test(item) &&
        (item < targetMigration || (includeTarget && item === targetMigration)),
    )
    .sort()) {
    cpSync(join(source, name), join(target, name), { recursive: true });
  }
}

function expectEqual<T>(label: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const NO_GAPS: OrthodonticModulesAudit = {
  dentistryInCatalog: true,
  missingSpecialtyModules: [],
  missingTenantModules: [],
};

async function addSpecialty(client: PrismaClient, id: string, code: string): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "Specialty" ("id", "code", "name", "updatedAt")
    VALUES (${id}, ${code}, ${code}, CURRENT_TIMESTAMP)
  `;
}

async function addClinic(client: PrismaClient, id: string, specialtyIds: string[]): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "Tenant" ("id", "name", "email", "updatedAt")
    VALUES (${id}, ${id}, ${`${id}@example.test`}, CURRENT_TIMESTAMP)
  `;
  for (const specialtyId of specialtyIds) {
    await client.$executeRaw`
      INSERT INTO "TenantSpecialty" ("tenantId", "specialtyId") VALUES (${id}, ${specialtyId})
    `;
  }
}

async function orthodonticTenantModules(client: PrismaClient): Promise<TenantModuleRow[]> {
  return client.$queryRaw<TenantModuleRow[]>`
    SELECT "tenantId", "moduleKey", "enabled" FROM "TenantModule"
    WHERE "moduleKey" LIKE 'dentistry.ortho-%' ORDER BY "tenantId", "moduleKey"
  `;
}

/**
 * Runs `scenario` against a fresh schema of the disposable database that holds every migration
 * before the target one, then drops the schema.
 */
async function inFreshSchema(
  baseUrl: string,
  scenario: (client: PrismaClient, applyTarget: () => void) => Promise<void>,
): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), temporaryPrefix));
  const schemaDir = join(temporary, 'prisma');
  mkdirSync(schemaDir);
  const schemaPath = join(schemaDir, 'schema.prisma');
  copyFileSync(join(__dirname, 'schema.prisma'), schemaPath);

  const schema = `orthodontic_modules_${randomBytes(8).toString('hex')}`;
  if (!schemaPattern.test(schema)) throw new Error('Invalid generated schema');
  const schemaUrl = urlForSchema(baseUrl, schema);
  const administrator = clientFor(baseUrl);
  const client = clientFor(schemaUrl);
  let schemaCreated = false;

  try {
    await administrator.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    copyMigrations(schemaDir, false);
    deploy(schemaPath, schemaUrl);
    await scenario(client, () => {
      copyMigrations(schemaDir, true);
      deploy(schemaPath, schemaUrl);
    });
  } finally {
    try {
      await client.$disconnect();
    } finally {
      try {
        if (schemaCreated) {
          if (!schemaPattern.test(schema)) throw new Error('Invalid generated schema on cleanup');
          await administrator.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        }
      } finally {
        try {
          await administrator.$disconnect();
        } finally {
          const resolvedTemporary = resolve(temporary);
          if (
            dirname(resolvedTemporary) !== resolve(tmpdir()) ||
            !basename(resolvedTemporary).startsWith(temporaryPrefix)
          ) {
            throw new Error('Refusing to remove an unexpected temporary directory');
          }
          rmSync(resolvedTemporary, { recursive: true, force: true });
        }
      }
    }
  }
}

/**
 * Upgrades a database that already has clinics, and one whose catalog has no dentistry yet,
 * through the orthodontic modules migration, and checks what it leaves in SpecialtyModule and
 * TenantModule.
 */
export async function verifyOrthodonticModulesMigration(
  databaseUrl: string | undefined = process.env.DATABASE_URL_TEST,
): Promise<{ clinicsBackfilled: number; tenantModulesCreated: number }> {
  assertSpecialtyStageDatabaseSafety(databaseUrl);
  const baseUrl = databaseUrl!;
  const keys = [...ORTHODONTIC_MODULE_KEYS].sort();
  let tenantModulesCreated = 0;

  // Clinics that existed before the migration.
  await inFreshSchema(baseUrl, async (client, applyTarget) => {
    await addSpecialty(client, 'spec_dentistry', 'DENTISTRY');
    await addSpecialty(client, 'spec_other', 'VERIFY_OTHER');
    await addClinic(client, 'clinic_dental', ['spec_dentistry']);
    await addClinic(client, 'clinic_mixed', ['spec_dentistry', 'spec_other']);
    await addClinic(client, 'clinic_other', ['spec_other']);
    await addClinic(client, 'clinic_none', []);
    // A row the clinic already has is left as it is.
    await client.$executeRaw`
      INSERT INTO "TenantModule" ("id", "tenantId", "moduleKey", "enabled", "updatedAt")
      VALUES ('tm_kept', 'clinic_mixed', 'dentistry.ortho-control', false, CURRENT_TIMESTAMP)
    `;

    // The audit sees every gap before the migration runs.
    const before = await auditOrthodonticModules(client);
    expectEqual(
      'Audit before the migration: specialty modules',
      before.missingSpecialtyModules,
      keys,
    );
    expectEqual('Audit before the migration: clinic modules', before.missingTenantModules, [
      ...keys.map((moduleKey) => ({ tenantId: 'clinic_dental', moduleKey })),
      ...keys
        .filter((moduleKey) => moduleKey !== 'dentistry.ortho-control')
        .map((moduleKey) => ({ tenantId: 'clinic_mixed', moduleKey })),
    ]);

    applyTarget();

    expectEqual(
      'Dentistry modules',
      await client.$queryRaw<{ moduleKey: string }[]>`
        SELECT sm."moduleKey" FROM "SpecialtyModule" sm
        WHERE sm."specialtyId" = 'spec_dentistry' AND sm."moduleKey" LIKE 'dentistry.ortho-%'
        ORDER BY sm."moduleKey"
      `,
      keys.map((moduleKey) => ({ moduleKey })),
    );
    const rows = await orthodonticTenantModules(client);
    expectEqual('Clinic modules', rows, [
      ...keys.map((moduleKey) => ({ tenantId: 'clinic_dental', moduleKey, enabled: true })),
      ...keys.map((moduleKey) => ({
        tenantId: 'clinic_mixed',
        moduleKey,
        enabled: moduleKey !== 'dentistry.ortho-control',
      })),
    ]);
    expectEqual('Audit after the migration', await auditOrthodonticModules(client), NO_GAPS);
    tenantModulesCreated = rows.length - 1;
  });

  // A catalog without dentistry: the migration adds it instead of linking nothing.
  await inFreshSchema(baseUrl, async (client, applyTarget) => {
    const before = await auditOrthodonticModules(client);
    expectEqual('Audit of a catalog without dentistry', before.dentistryInCatalog, false);

    applyTarget();

    expectEqual(
      'Dentistry in the catalog',
      await client.$queryRaw<{ name: string; isActive: boolean }[]>`
        SELECT "name", "isActive" FROM "Specialty" WHERE "code" = 'DENTISTRY'
      `,
      [{ name: 'Odontología', isActive: true }],
    );
    expectEqual('Audit after adding dentistry', await auditOrthodonticModules(client), NO_GAPS);
    expectEqual('Clinic modules without clinics', await orthodonticTenantModules(client), []);
  });

  return { clinicsBackfilled: 2, tenantModulesCreated };
}

if (require.main === module) {
  verifyOrthodonticModulesMigration()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
