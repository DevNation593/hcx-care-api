import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PrismaClient } from '@prisma/client';
import { assertSpecialtyStageDatabaseSafety } from '../test/helpers/assert-e2e-database';

const targetMigration = '20261113000000_personal_owner_professional_profile';
const schemaPattern = /^personal_owner_[a-f0-9]{16}$/;
const temporaryPrefix = 'personal-owner-migration-';

type ProfileRow = { userId: string; specialtyId: string; isActive: boolean };
type SpecialtyLinkRow = { userId: string; specialtyId: string; isPrimary: boolean };
type SeatRow = { tenantId: string; seatsPsychologistsUsed: number };

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

async function addSpecialty(client: PrismaClient, id: string): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "Specialty" ("id", "code", "name", "updatedAt")
    VALUES (${id}, ${`VERIFY_${id.toUpperCase()}`}, ${id}, CURRENT_TIMESTAMP)
  `;
}

async function addTenant(
  client: PrismaClient,
  id: string,
  tenantType: 'PERSONAL' | 'CLINIC',
  planId: string,
  seatsUsed: number,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "Tenant" ("id", "name", "email", "tenantType", "updatedAt")
     VALUES ($1, $1, $2, $3::"TenantType", CURRENT_TIMESTAMP)`,
    id,
    `${id}@example.test`,
    tenantType,
  );
  await client.$executeRaw`
    INSERT INTO "TenantSubscription" ("id", "tenantId", "planId", "seatsPsychologistsUsed", "updatedAt")
    VALUES (${`sub_${id}`}, ${id}, ${planId}, ${seatsUsed}, CURRENT_TIMESTAMP)
  `;
}

async function enable(
  client: PrismaClient,
  tenantId: string,
  specialtyId: string,
  createdAt: string,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO "TenantSpecialty" ("tenantId", "specialtyId", "createdAt")
     VALUES ($1, $2, $3::timestamp)`,
    tenantId,
    specialtyId,
    createdAt,
  );
}

async function addUser(
  client: PrismaClient,
  id: string,
  tenantId: string,
  role: 'MASTER' | 'PROFESIONAL',
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

async function addProfile(
  client: PrismaClient,
  userId: string,
  specialtyId: string,
  isActive: boolean,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "ProfessionalProfile" ("userId", "specialtyId", "isActive", "updatedAt")
    VALUES (${userId}, ${specialtyId}, ${isActive}, CURRENT_TIMESTAMP)
  `;
}

async function link(
  client: PrismaClient,
  userId: string,
  specialtyId: string,
  isPrimary: boolean,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "ProfessionalSpecialty" ("userId", "specialtyId", "isPrimary")
    VALUES (${userId}, ${specialtyId}, ${isPrimary})
  `;
}

function expectRows<T>(label: string, actual: T[], expected: T[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export async function verifyPersonalOwnerProfileMigration(
  databaseUrl: string | undefined = process.env.DATABASE_URL_TEST,
): Promise<{ profilesCreated: number; untouchedMasters: number }> {
  assertSpecialtyStageDatabaseSafety(databaseUrl);
  const baseUrl = databaseUrl!;
  const temporary = mkdtempSync(join(tmpdir(), temporaryPrefix));
  const schemaDir = join(temporary, 'prisma');
  mkdirSync(schemaDir);
  const schemaPath = join(schemaDir, 'schema.prisma');
  copyFileSync(join(__dirname, 'schema.prisma'), schemaPath);

  const schema = `personal_owner_${randomBytes(8).toString('hex')}`;
  if (!schemaPattern.test(schema)) throw new Error('Invalid generated schema');
  const administrator = clientFor(baseUrl);
  const client = clientFor(urlForSchema(baseUrl, schema));
  let schemaCreated = false;

  try {
    await administrator.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    copyEarlierMigrations(schemaDir);
    deploy(schemaPath, urlForSchema(baseUrl, schema));

    const plans = await client.$queryRaw<{ id: string; tenantType: string }[]>`
      SELECT "id", "tenantType"::text AS "tenantType" FROM "Plan" ORDER BY "sortOrder"
    `;
    const personalPlan = plans.find((plan) => plan.tenantType === 'PERSONAL')!.id;
    const clinicPlan = plans.find((plan) => plan.tenantType === 'CLINIC')!.id;
    for (const id of ['spec_a', 'spec_b', 'spec_c']) await addSpecialty(client, id);

    // The oldest specialty of the practice.
    await addTenant(client, 'personal_plain', 'PERSONAL', personalPlan, 0);
    await enable(client, 'personal_plain', 'spec_b', '2026-01-02T00:00:00');
    await enable(client, 'personal_plain', 'spec_a', '2026-01-01T00:00:00');
    await addUser(client, 'plain_master', 'personal_plain', 'MASTER');
    // The primary specialty the master already had.
    await addTenant(client, 'personal_primary', 'PERSONAL', personalPlan, 0);
    await enable(client, 'personal_primary', 'spec_a', '2026-01-01T00:00:00');
    await enable(client, 'personal_primary', 'spec_b', '2026-01-02T00:00:00');
    await addUser(client, 'primary_master', 'personal_primary', 'MASTER');
    await link(client, 'primary_master', 'spec_b', true);
    // A primary specialty the practice no longer has is demoted.
    await addTenant(client, 'personal_stale', 'PERSONAL', personalPlan, 0);
    await enable(client, 'personal_stale', 'spec_a', '2026-01-01T00:00:00');
    await addUser(client, 'stale_master', 'personal_stale', 'MASTER');
    await link(client, 'stale_master', 'spec_c', true);
    // A master that already has a profile keeps it, inactive included.
    await addTenant(client, 'personal_profiled', 'PERSONAL', personalPlan, 0);
    await enable(client, 'personal_profiled', 'spec_a', '2026-01-01T00:00:00');
    await enable(client, 'personal_profiled', 'spec_b', '2026-01-02T00:00:00');
    await addUser(client, 'profiled_master', 'personal_profiled', 'MASTER');
    await addProfile(client, 'profiled_master', 'spec_b', false);
    // Without a specialty there is nothing to give.
    await addTenant(client, 'personal_empty', 'PERSONAL', personalPlan, 0);
    await addUser(client, 'empty_master', 'personal_empty', 'MASTER');
    // A clinic's master stays an account holder; its seat count is left as it is.
    await addTenant(client, 'clinic', 'CLINIC', clinicPlan, 7);
    await enable(client, 'clinic', 'spec_a', '2026-01-01T00:00:00');
    await addUser(client, 'clinic_master', 'clinic', 'MASTER');
    await addUser(client, 'clinic_professional', 'clinic', 'PROFESIONAL');
    await addProfile(client, 'clinic_professional', 'spec_a', true);

    cpSync(
      join(__dirname, 'migrations', targetMigration),
      join(schemaDir, 'migrations', targetMigration),
      { recursive: true },
    );
    deploy(schemaPath, urlForSchema(baseUrl, schema));

    expectRows(
      'Professional profiles',
      await client.$queryRaw<ProfileRow[]>`
        SELECT "userId", "specialtyId", "isActive" FROM "ProfessionalProfile" ORDER BY "userId"
      `,
      [
        { userId: 'clinic_professional', specialtyId: 'spec_a', isActive: true },
        { userId: 'plain_master', specialtyId: 'spec_a', isActive: true },
        { userId: 'primary_master', specialtyId: 'spec_b', isActive: true },
        { userId: 'profiled_master', specialtyId: 'spec_b', isActive: false },
        { userId: 'stale_master', specialtyId: 'spec_a', isActive: true },
      ],
    );
    expectRows(
      'Professional specialties',
      await client.$queryRaw<SpecialtyLinkRow[]>`
        SELECT "userId", "specialtyId", "isPrimary" FROM "ProfessionalSpecialty"
        ORDER BY "userId", "specialtyId"
      `,
      [
        { userId: 'plain_master', specialtyId: 'spec_a', isPrimary: true },
        { userId: 'primary_master', specialtyId: 'spec_b', isPrimary: true },
        { userId: 'stale_master', specialtyId: 'spec_a', isPrimary: true },
        { userId: 'stale_master', specialtyId: 'spec_c', isPrimary: false },
      ],
    );
    expectRows(
      'Seat counts',
      await client.$queryRaw<SeatRow[]>`
        SELECT "tenantId", "seatsPsychologistsUsed" FROM "TenantSubscription" ORDER BY "tenantId"
      `,
      [
        { tenantId: 'clinic', seatsPsychologistsUsed: 7 },
        { tenantId: 'personal_empty', seatsPsychologistsUsed: 0 },
        { tenantId: 'personal_plain', seatsPsychologistsUsed: 1 },
        { tenantId: 'personal_primary', seatsPsychologistsUsed: 1 },
        { tenantId: 'personal_profiled', seatsPsychologistsUsed: 0 },
        { tenantId: 'personal_stale', seatsPsychologistsUsed: 1 },
      ],
    );

    return { profilesCreated: 3, untouchedMasters: 3 };
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
  verifyPersonalOwnerProfileMigration()
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
