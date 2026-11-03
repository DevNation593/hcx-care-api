import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const TARGET = '20261102000100_drop_emite_facil';
const migrationsDir = join(__dirname, '..', 'prisma', 'migrations');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Runs only against a local disposable server named explicitly in DATABASE_URL; it creates and
// drops its own database there and never writes to the database the URL names.
const baseUrl = process.env.DATABASE_URL;
const disposable = (() => {
  try {
    return !!baseUrl && LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
})();

function deploy(root: string, url: string) {
  const cli = require.resolve('prisma/build/index.js');
  // cwd is the temporary copy so the project's prisma.config.ts (and its migrations path) is not used.
  const result = spawnSync(
    process.execPath,
    [cli, 'migrate', 'deploy', '--schema', join(root, 'prisma', 'schema.prisma')],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 180000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (!output.includes('All migrations have been successfully applied'))
    throw new Error(`Migration deploy failed\n${output.slice(-2000)}`);
}

function copyMigration(root: string, name: string) {
  cpSync(join(migrationsDir, name), join(root, 'prisma', 'migrations', name), { recursive: true });
}

(disposable ? describe : describe.skip)('own SRI invoicing deletion migration', () => {
  jest.setTimeout(300000);
  const database = `own_sri_migration_${randomBytes(6).toString('hex')}`;
  const root = mkdtempSync(join(tmpdir(), 'own-sri-migration-'));
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  const url = (() => {
    const parsed = new URL(baseUrl ?? 'postgres://localhost/unused');
    parsed.pathname = `/${database}`;
    return parsed.toString();
  })();
  const db = new PrismaClient({ datasources: { db: { url } } });
  const run = (sql: string) => db.$executeRawUnsafe(sql);
  const one = async <T>(sql: string) => (await db.$queryRawUnsafe<T[]>(sql))[0];

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    mkdirSync(join(root, 'prisma', 'migrations'), { recursive: true });
    copyFileSync(
      join(__dirname, '..', 'prisma', 'schema.prisma'),
      join(root, 'prisma', 'schema.prisma'),
    );
    copyFileSync(
      join(migrationsDir, 'migration_lock.toml'),
      join(root, 'prisma', 'migrations', 'migration_lock.toml'),
    );
    for (const name of readdirSync(migrationsDir).filter((n) => /^\d+_/.test(n)))
      if (name < TARGET) copyMigration(root, name);
    deploy(root, url);

    await run(
      `INSERT INTO "Tenant" ("id","name","email","updatedAt") VALUES ('t','T','t@example.test',now())`,
    );
    await run(
      `INSERT INTO "User" ("id","tenantId","email","password","firstName","lastName","role","updatedAt")
       VALUES ('u','t','u@example.test','x','U','U','MASTER',now())`,
    );
    await run(
      `INSERT INTO "Specialty" ("id","code","name","updatedAt") VALUES ('sp','OWN_SRI_TEST','S',now())`,
    );
    await run(
      `INSERT INTO "Patient" ("id","tenantId","firstName","lastName","updatedAt") VALUES ('p','t','P','P',now())`,
    );
    await run(
      `INSERT INTO "Branch" ("id","tenantId","name","updatedAt") VALUES ('b1','t','Old',now()),('b2','t','New',now())`,
    );
    await run(
      `INSERT INTO "Treatment" ("id","tenantId","name","code","updatedAt") VALUES ('tr','t','Tr','TR',now())`,
    );
    await run(
      `INSERT INTO "TreatmentVersion" ("id","tenantId","treatmentId","version","price","taxRatePercent","durationMinutes","requirements","createdById")
       VALUES ('tv','t','tr',1,10,0,30,'{}','u')`,
    );
    await run(
      `INSERT INTO "BillingProfile" ("id","tenantId","kind","idType","idNumber","legalName","createdById","updatedAt")
       VALUES ('bp','t','PERSON','05','1710034065','Ana','u',now())`,
    );
    await run(
      `INSERT INTO "InvoicingConnection" ("id","tenantId","apiKeyEncrypted","externalTenantId","taxpayerId","taxpayerName","taxpayerRuc","environment","validatedAt","updatedAt")
       VALUES ('c','t','enc','x','tp','T','1710034065001','1',now(),now())`,
    );
    await run(
      `INSERT INTO "InvoicingIssuer" ("id","tenantId","ruc","legalName","headOfficeAddress","accountingRequired","environment","updatedAt")
       VALUES ('i','t','1710034065001','T','Quito',false,'1',now())`,
    );
    await run(
      `INSERT INTO "BranchEmissionPoint" ("id","branchId","connectionId","establishmentId","emissionPointId","establishmentCode","emissionPointCode","updatedAt")
       VALUES ('pt_old','b1','c','e','ep','001','001',now())`,
    );
    await run(
      `INSERT INTO "BranchEmissionPoint" ("id","branchId","issuerId","establishmentCode","emissionPointCode","establishmentAddress","updatedAt")
       VALUES ('pt_new','b2','i','002','001','Quito',now())`,
    );
    // One session per order: A (authorized), B (processing), C (old rejected, new authorized),
    // D (old failed, already paid again).
    const sessions = { A: 'BILLED', B: 'BILLING_PENDING', C: 'BILLED', D: 'BILLING_FAILED' };
    let number = 1;
    for (const [key, status] of Object.entries(sessions)) {
      await run(
        `INSERT INTO "Encounter" ("id","tenantId","patientId","professionalId","specialtyId","encounterType","reason","updatedAt")
         VALUES ('enc${key}','t','p','u','sp','PROCEDURE','r',now())`,
      );
      await run(
        `INSERT INTO "TreatmentSession" ("id","tenantId","patientId","professionalId","treatmentVersionId","encounterId","status","completedAt","updatedAt")
         VALUES ('s${key}','t','p','u','tv','enc${key}','${status}',now(),now())`,
      );
      await run(
        `INSERT INTO "Order" ("id","tenantId","branchId","number","status","billingProfileId","createdById","updatedAt")
         VALUES ('o${key}','t','b1',${number++},'${key === 'D' ? 'PAID' : 'INVOICED'}','bp','u',now())`,
      );
      await run(
        `INSERT INTO "OrderItem" ("id","tenantId","orderId","kind","treatmentSessionId","patientId","description","quantity","unitPrice","taxRatePercent","lineSubtotal","lineTax","createdById")
         VALUES ('it${key}','t','o${key}','TREATMENT_SESSION','s${key}','p','d',1,10,0,10,0,'u')`,
      );
    }
    const oldRequest = (id: string, order: string, status: string, root = id) =>
      run(
        `INSERT INTO "InvoiceRequest" ("id","tenantId","orderId","connectionId","billingProfileId","requestedById","status","clientIdempotencyKey","providerIdempotencyKey","snapshotEncrypted","rootRequestId","externalDocumentId","requiresReconciliation","updatedAt")
         VALUES ('${id}','t','${order}','c','bp','u','${status}','k-${id}','pk-${id}','enc','${root}','doc-${id}',${status === 'PROCESSING'},now())`,
      );
    await oldRequest('rA', 'oA', 'AUTHORIZED');
    await oldRequest('rB', 'oB', 'PROCESSING');
    await oldRequest('rC', 'oC', 'REJECTED');
    await oldRequest('rD1', 'oD', 'REJECTED');
    await run(`UPDATE "InvoiceRequest" SET "status"='FAILED' WHERE "id"='rD1'`);
    await oldRequest('rD2', 'oD', 'FAILED', 'rD1');
    await run(`UPDATE "InvoiceRequest" SET "replacesInvoiceRequestId"='rD1' WHERE "id"='rD2'`);
    await run(
      `INSERT INTO "InvoiceRequest" ("id","tenantId","orderId","issuerId","billingProfileId","requestedById","status","clientIdempotencyKey","snapshotEncrypted","rootRequestId","replacesInvoiceRequestId","sequential","updatedAt")
       VALUES ('rC2','t','oC','i','bp','u','AUTHORIZED','k-rC2','enc','rC','rC','000000001',now())`,
    );
    await run(
      `INSERT INTO "InvoiceRequestEvent" ("id","connectionId","invoiceRequestId","type","source","detail","webhookEventId") VALUES
       ('evA','c','rA','AUTHORIZED','WEBHOOK','{}','wh-1'),
       ('evB','c','rB','REQUESTED','API','{}',NULL),
       ('evOrphan','c',NULL,'WEBHOOK_IGNORED','WEBHOOK','{}','wh-2')`,
    );
    await run(
      `INSERT INTO "InvoiceRequestEvent" ("id","issuerId","invoiceRequestId","type","source","detail")
       VALUES ('evC2','i','rC2','AUTHORIZED','WORKER','{}')`,
    );

    copyMigration(root, TARGET);
    deploy(root, url);
  });

  afterAll(async () => {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.$disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  it('deletes the Emite Fácil requests, events and points and keeps the SRI ones', async () => {
    const ids = async (table: string) =>
      (await db.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "${table}" ORDER BY "id"`)).map(
        (r) => r.id,
      );
    expect(await ids('InvoiceRequest')).toEqual(['rC2']);
    expect(await ids('InvoiceRequestEvent')).toEqual(['evC2']);
    expect(await ids('BranchEmissionPoint')).toEqual(['pt_new']);
  });

  it('returns orders invoiced only through Emite Fácil to PAID and fails their billed sessions', async () => {
    const order = (id: string) =>
      one<{ status: string; version: number }>(
        `SELECT "status"::text, "version" FROM "Order" WHERE "id"='${id}'`,
      );
    const session = (id: string) =>
      one<{ status: string; version: number }>(
        `SELECT "status"::text, "version" FROM "TreatmentSession" WHERE "id"='${id}'`,
      );
    expect(await order('oA')).toEqual({ status: 'PAID', version: 2 });
    expect(await order('oB')).toEqual({ status: 'PAID', version: 2 });
    expect(await session('sA')).toEqual({ status: 'BILLING_FAILED', version: 2 });
    expect(await session('sB')).toEqual({ status: 'BILLING_FAILED', version: 2 });
    // An order whose latest request is an SRI one keeps its status, as do its sessions.
    expect(await order('oC')).toEqual({ status: 'INVOICED', version: 1 });
    expect(await session('sC')).toEqual({ status: 'BILLED', version: 1 });
    // An order already billable again is untouched.
    expect(await order('oD')).toEqual({ status: 'PAID', version: 1 });
    expect(await session('sD')).toEqual({ status: 'BILLING_FAILED', version: 1 });
  });

  it('starts an SRI chain that replaced an Emite Fácil request at itself', async () => {
    expect(
      await one(
        `SELECT "rootRequestId", "replacesInvoiceRequestId" FROM "InvoiceRequest" WHERE "id"='rC2'`,
      ),
    ).toEqual({ rootRequestId: 'rC2', replacesInvoiceRequestId: null });
  });

  it('drops the provider tables and columns', async () => {
    const tables = await db.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN ('InvoicingConnection','InvoicingRef')`,
    );
    expect(tables).toEqual([]);
    const columns = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name IN ('InvoiceRequest','InvoiceRequestEvent','BranchEmissionPoint')
         AND column_name IN ('connectionId','externalDocumentId','providerIdempotencyKey',
           'providerBodyEncrypted','providerBodyHash','requiresReconciliation','webhookEventId',
           'establishmentId','emissionPointId')`,
    );
    expect(columns).toEqual([]);
    const nullable = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND is_nullable='YES'
         AND ((table_name IN ('InvoiceRequest','InvoiceRequestEvent','BranchEmissionPoint')
               AND column_name='issuerId')
           OR (table_name='BranchEmissionPoint' AND column_name='establishmentAddress'))`,
    );
    expect(nullable).toEqual([]);
  });
});
