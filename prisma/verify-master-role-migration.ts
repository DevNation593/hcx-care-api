import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { assertSpecialtyStageDatabaseSafety } from '../test/helpers/assert-e2e-database';
import { auditMasterRoles, hasBlockingIssues } from './audit-master-roles';

const targetMigrations = ['20261002000000_add_master_role', '20261002000100_backfill_master_role'];
const schemaPattern = /^master_role_[a-f0-9]+$/;

type RoleRow = { id: string; role: string };

function clientFor(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

function urlForSchema(baseUrl: string, schema: string): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

function deploy(schemaPath: string, url: string): string {
  const cli = require.resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: join(schemaPath, '..', '..'),
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.error) throw new Error(`Prisma migration process failed: ${result.error.message}`);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (
    !output.includes('All migrations have been successfully applied') &&
    !output.includes('Your database is now in sync')
  ) {
    // Credentials are stripped before the output reaches a log.
    throw new Error(
      `Migration deploy failed\n${output
        .replace(/(postgres(?:ql)?:\/\/)[^@\s/]*@/gi, '$1***@')
        .trim()
        .slice(-2000)}`,
    );
  }
  return output;
}

function copyMigrations(destination: string, includeTargets: boolean): void {
  const source = join(__dirname, 'migrations');
  const target = join(destination, 'migrations');
  mkdirSync(target, { recursive: true });
  copyFileSync(join(source, 'migration_lock.toml'), join(target, 'migration_lock.toml'));
  for (const name of readdirSync(source)
    .filter((item) => /^\d+_/.test(item))
    .sort()) {
    // Seed legacy roles in the real pre-MASTER schema. Later migrations may already
    // reference MASTER and must be applied only after the role migration itself.
    if (!includeTargets && name >= targetMigrations[0]) continue;
    cpSync(join(source, name), join(target, name), { recursive: true });
  }
}

async function addUser(
  client: PrismaClient,
  id: string,
  tenantId: string,
  role: string,
  createdAt: string,
  active = true,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "User" ("id", "tenantId", "email", "password", "firstName", "lastName", "role", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'fixture', 'Fixture', 'User', $4::"UserRole", $5, $6::timestamp, CURRENT_TIMESTAMP)`,
    id,
    tenantId,
    `${id}@example.test`,
    role,
    active,
    createdAt,
  );
}

export async function verifyMasterRoleMigration(
  databaseUrl: string | undefined = process.env.DATABASE_URL_TEST,
): Promise<{ migratedUsers: number; rejectedSecondMaster: true }> {
  assertSpecialtyStageDatabaseSafety(databaseUrl);
  const baseUrl = databaseUrl!;
  const temporary = mkdtempSync(join(tmpdir(), 'master-role-migration-'));
  const schemaDir = join(temporary, 'prisma');
  mkdirSync(schemaDir);
  const schemaPath = join(schemaDir, 'schema.prisma');
  copyFileSync(join(__dirname, 'schema.prisma'), schemaPath);
  const administrator = clientFor(baseUrl);
  const schema = `master_role_${randomBytes(8).toString('hex')}`;
  if (!schemaPattern.test(schema)) throw new Error('Invalid generated schema');
  const client = clientFor(urlForSchema(baseUrl, schema));
  let schemaCreated = false;

  try {
    await administrator.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    copyMigrations(schemaDir, false);
    deploy(schemaPath, urlForSchema(baseUrl, schema));

    for (const tenantId of ['tenant_a', 'tenant_b']) {
      await client.$executeRawUnsafe(
        `INSERT INTO "Tenant" ("id", "name", "email", "updatedAt") VALUES ($1, $1, $2, CURRENT_TIMESTAMP)`,
        tenantId,
        `${tenantId}@example.test`,
      );
    }
    // tenant_a: the oldest administrator wins; the newer one and the psychologist are demoted.
    await addUser(client, 'a_admin_old', 'tenant_a', 'ADMIN', '2026-01-01');
    await addUser(client, 'a_cliente_new', 'tenant_a', 'CLIENTE', '2026-02-01');
    await addUser(client, 'a_psicologo', 'tenant_a', 'PSICOLOGO', '2026-01-15');
    await addUser(client, 'a_asistente', 'tenant_a', 'ASISTENTE', '2026-01-10');
    // tenant_b: an inactive administrator is older than the active one; the active one wins.
    await addUser(client, 'b_admin_inactive_old', 'tenant_b', 'ADMIN', '2026-01-01', false);
    await addUser(client, 'b_admin_active_new', 'tenant_b', 'ADMIN', '2026-03-01');

    copyMigrations(schemaDir, true);
    deploy(schemaPath, urlForSchema(baseUrl, schema));

    const rows = await client.$queryRawUnsafe<RoleRow[]>(
      `SELECT "id", "role"::text AS role FROM "User" ORDER BY "id"`,
    );
    const actual = Object.fromEntries(rows.map((row) => [row.id, row.role]));
    const expected = {
      a_admin_old: 'MASTER',
      a_asistente: 'ASISTENTE',
      a_cliente_new: 'PROFESIONAL',
      a_psicologo: 'PROFESIONAL',
      b_admin_active_new: 'MASTER',
      b_admin_inactive_old: 'PROFESIONAL',
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Backfill produced unexpected roles: ${JSON.stringify(actual)}`);
    }

    let rejected = false;
    try {
      await addUser(client, 'a_second_master', 'tenant_a', 'MASTER', '2026-04-01');
    } catch (error) {
      const detail = `${error instanceof Error ? error.message : ''} ${JSON.stringify((error as { meta?: unknown }).meta ?? '')}`;
      if (!detail.includes('User_tenantId_master_key') && !detail.includes('23505')) throw error;
      rejected = true;
    }
    if (!rejected) throw new Error('A second MASTER was accepted for the same tenant');

    const audit = await auditMasterRoles(client);
    if (hasBlockingIssues(audit)) {
      throw new Error(`Audit found blocking issues: ${JSON.stringify(audit)}`);
    }
    const demoted = ['a_cliente_new', 'a_psicologo', 'b_admin_inactive_old'];
    if (JSON.stringify([...audit.professionalsWithoutProfile].sort()) !== JSON.stringify(demoted)) {
      throw new Error('Audit did not list the demoted users lacking a professional profile');
    }
    return { migratedUsers: rows.length, rejectedSecondMaster: true };
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
            !basename(resolvedTemporary).startsWith('master-role-migration-')
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
  verifyMasterRoleMigration()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
