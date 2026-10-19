import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { assertSpecialtyStageDatabaseSafety } from '../test/helpers/assert-e2e-database';

const targetMigration = '20261018000000_platform_role_permissions';
const schemaPattern = /^role_permissions_[a-f0-9]{16}$/;
const temporaryPrefix = 'role-permissions-migration-';

type RolePermissionRow = {
  tenantId: string;
  role: string;
  permission: string;
  granted: boolean;
};

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

function copyEarlierMigrations(destination: string): void {
  const source = join(__dirname, 'migrations');
  const target = join(destination, 'migrations');
  mkdirSync(target, { recursive: true });
  copyFileSync(join(source, 'migration_lock.toml'), join(target, 'migration_lock.toml'));
  for (const name of readdirSync(source)
    .filter((item) => /^\d+_/.test(item) && item < targetMigration)
    .sort()) {
    cpSync(join(source, name), join(target, name), { recursive: true });
  }
}

async function addTenant(client: PrismaClient, id: string): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "Tenant" ("id", "name", "email", "updatedAt")
    VALUES (${id}, ${id}, ${`${id}@example.test`}, CURRENT_TIMESTAMP)
  `;
}

async function addUser(
  client: PrismaClient,
  id: string,
  tenantId: string,
  role: 'MASTER' | 'PROFESIONAL' | 'ASISTENTE',
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "tenantId", "email", "password", "firstName", "lastName", "role", "updatedAt")
     VALUES ($1, $2, $3, 'fixture', 'Fixture', 'User', $4::"UserRole", CURRENT_TIMESTAMP)`,
    id,
    tenantId,
    `${id}@example.test`,
    role,
  );
}

async function addPersonalPermission(
  client: PrismaClient,
  id: string,
  tenantId: string,
  userId: string,
  permission: string,
  granted: boolean,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "UserPermission" ("id", "tenantId", "userId", "permission", "granted")
    VALUES (${id}, ${tenantId}, ${userId}, ${permission}, ${granted})
  `;
}

export async function verifyPlatformRolePermissionsMigration(
  databaseUrl: string | undefined = process.env.DATABASE_URL_TEST,
): Promise<{
  migratedRevocations: number;
  historicalRowsPreserved: number;
  duplicateRejected: true;
}> {
  assertSpecialtyStageDatabaseSafety(databaseUrl);
  const baseUrl = databaseUrl!;
  const temporary = mkdtempSync(join(tmpdir(), temporaryPrefix));
  const schemaDir = join(temporary, 'prisma');
  mkdirSync(schemaDir);
  const schemaPath = join(schemaDir, 'schema.prisma');
  copyFileSync(join(__dirname, 'schema.prisma'), schemaPath);

  const schema = `role_permissions_${randomBytes(8).toString('hex')}`;
  if (!schemaPattern.test(schema)) throw new Error('Invalid generated schema');
  const administrator = clientFor(baseUrl);
  const client = clientFor(urlForSchema(baseUrl, schema));
  let schemaCreated = false;

  try {
    await administrator.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    copyEarlierMigrations(schemaDir);
    deploy(schemaPath, urlForSchema(baseUrl, schema));

    await addTenant(client, 'clinic_a');
    await addTenant(client, 'clinic_b');
    await addUser(client, 'a_master', 'clinic_a', 'MASTER');
    await addUser(client, 'a_professional_1', 'clinic_a', 'PROFESIONAL');
    await addUser(client, 'a_professional_2', 'clinic_a', 'PROFESIONAL');
    await addUser(client, 'a_assistant', 'clinic_a', 'ASISTENTE');
    await addUser(client, 'b_master', 'clinic_b', 'MASTER');
    await addUser(client, 'b_professional', 'clinic_b', 'PROFESIONAL');

    await addPersonalPermission(
      client,
      'p1',
      'clinic_a',
      'a_professional_1',
      'patients.create',
      false,
    );
    await addPersonalPermission(
      client,
      'p2',
      'clinic_a',
      'a_professional_2',
      'patients.create',
      true,
    );
    await addPersonalPermission(client, 'p3', 'clinic_a', 'a_professional_2', 'billing.view', true);
    await addPersonalPermission(
      client,
      'p4',
      'clinic_a',
      'a_assistant',
      'appointments.cancel',
      false,
    );
    await addPersonalPermission(client, 'p5', 'clinic_a', 'a_master', 'billing.create', false);
    await addPersonalPermission(
      client,
      'p6',
      'clinic_b',
      'b_professional',
      'patients.create',
      true,
    );

    cpSync(
      join(__dirname, 'migrations', targetMigration),
      join(schemaDir, 'migrations', targetMigration),
      { recursive: true },
    );
    deploy(schemaPath, urlForSchema(baseUrl, schema));

    const rows = await client.$queryRawUnsafe<RolePermissionRow[]>(
      `SELECT "tenantId", "role"::text AS role, "permission", "granted"
       FROM "TenantRolePermission" ORDER BY "tenantId", "role"::text, "permission"`,
    );
    const expected: RolePermissionRow[] = [
      {
        tenantId: 'clinic_a',
        role: 'ASISTENTE',
        permission: 'appointments.cancel',
        granted: false,
      },
      { tenantId: 'clinic_a', role: 'MASTER', permission: 'billing.create', granted: false },
      { tenantId: 'clinic_a', role: 'PROFESIONAL', permission: 'patients.create', granted: false },
    ];
    if (JSON.stringify(rows) !== JSON.stringify(expected)) {
      throw new Error(`Role permission backfill produced unexpected rows: ${JSON.stringify(rows)}`);
    }

    const historical = await client.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*)::int AS count FROM "UserPermission"`,
    );
    if (historical[0]?.count !== 6)
      throw new Error('Personal permission history was not preserved');

    let duplicateRejected = false;
    try {
      await client.$executeRaw`
        INSERT INTO "TenantRolePermission" ("id", "tenantId", "role", "permission", "granted")
        VALUES ('duplicate', 'clinic_a', 'PROFESIONAL'::"UserRole", 'patients.create', FALSE)
      `;
    } catch (error) {
      const code = (error as { code?: string; meta?: { code?: string } }).code;
      const databaseCode = (error as { meta?: { code?: string } }).meta?.code;
      if (code !== 'P2002' && databaseCode !== '23505') throw error;
      duplicateRejected = true;
    }
    if (!duplicateRejected) throw new Error('A duplicate clinic role permission was accepted');

    return {
      migratedRevocations: rows.length,
      historicalRowsPreserved: 6,
      duplicateRejected: true,
    };
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

if (require.main === module) {
  verifyPlatformRolePermissionsMigration()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
