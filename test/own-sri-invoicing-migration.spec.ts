import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { auditFormerProviderRemoval } from '../prisma/audit-emite-facil-removal';

const TARGET = '20261102000100_drop_emite_facil';
const ADDITIVE = '20261102000000_own_sri_issuer';
const migrationsDir = join(__dirname, '..', 'prisma', 'migrations');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Runs only against a local disposable server named explicitly in DATABASE_URL; it creates and
// drops its own databases there and never writes to the database the URL names.
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

/**
 * A fresh database migrated up to, not including, `before`; `apply` deploys `before` and every
 * later migration.
 */
class Stage {
  readonly database = `own_sri_migration_${randomBytes(6).toString('hex')}`;
  readonly root = mkdtempSync(join(tmpdir(), 'own-sri-migration-'));
  readonly db: PrismaClient;
  private readonly admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  private readonly url: string;

  constructor(private readonly before = TARGET) {
    const parsed = new URL(baseUrl!);
    parsed.pathname = `/${this.database}`;
    this.url = parsed.toString();
    this.db = new PrismaClient({ datasources: { db: { url: this.url } } });
  }

  async create() {
    await this.admin.$executeRawUnsafe(`CREATE DATABASE "${this.database}"`);
    mkdirSync(join(this.root, 'prisma', 'migrations'), { recursive: true });
    copyFileSync(
      join(__dirname, '..', 'prisma', 'schema.prisma'),
      join(this.root, 'prisma', 'schema.prisma'),
    );
    copyFileSync(
      join(migrationsDir, 'migration_lock.toml'),
      join(this.root, 'prisma', 'migrations', 'migration_lock.toml'),
    );
    for (const name of readdirSync(migrationsDir).filter((n) => /^\d+_/.test(n)))
      if (name < this.before) this.copy(name);
    deploy(this.root, this.url);
  }

  apply() {
    for (const name of readdirSync(migrationsDir).filter((n) => /^\d+_/.test(n)))
      if (name >= this.before) this.copy(name);
    deploy(this.root, this.url);
  }

  async drop() {
    await this.db.$disconnect();
    await this.admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${this.database}" WITH (FORCE)`);
    await this.admin.$disconnect();
    rmSync(this.root, { recursive: true, force: true });
  }

  run = (sql: string) => this.db.$executeRawUnsafe(sql);
  one = async <T>(sql: string) => (await this.db.$queryRawUnsafe<T[]>(sql))[0];
  ids = async (table: string) =>
    (
      await this.db.$queryRawUnsafe<{ id: string }[]>(`SELECT "id" FROM "${table}" ORDER BY "id"`)
    ).map((r) => r.id);
  status = (table: 'Order' | 'TreatmentSession', id: string) =>
    this.one<{ status: string; version: number }>(
      `SELECT "status"::text, "version" FROM "${table}" WHERE "id"='${id}'`,
    );

  private copy(name: string) {
    cpSync(join(migrationsDir, name), join(this.root, 'prisma', 'migrations', name), {
      recursive: true,
    });
  }
}

/**
 * One session per order: A (old authorized), B (old processing), C (old rejected replaced by an
 * authorized SRI request), D (old failed twice, paid again), E (SRI rejected, then old authorized).
 */
async function seed({ run }: Stage, environment: '1' | '2') {
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
     VALUES ('c','t','enc','x','tp','T','1710034065001','${environment}',now(),now())`,
  );
  await run(
    `INSERT INTO "InvoicingRef" ("id","connectionId","kind","localId","externalId","syncedHash","updatedAt")
     VALUES ('ref','c','CUSTOMER','bp','ext','h',now())`,
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
  const sessions = {
    A: 'BILLED',
    B: 'BILLING_PENDING',
    C: 'BILLED',
    D: 'BILLING_FAILED',
    E: 'BILLED',
  };
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
  const oldRequest = (id: string, order: string, status: string, root = id, replaces?: string) =>
    run(
      `INSERT INTO "InvoiceRequest" ("id","tenantId","orderId","connectionId","billingProfileId","requestedById","status","clientIdempotencyKey","providerIdempotencyKey","snapshotEncrypted","rootRequestId","replacesInvoiceRequestId","externalDocumentId","requiresReconciliation","updatedAt")
       VALUES ('${id}','t','${order}','c','bp','u','${status}','k-${id}','pk-${id}','enc','${root}',${replaces ? `'${replaces}'` : 'NULL'},'doc-${id}',${status === 'PROCESSING'},now())`,
    );
  const sriRequest = (id: string, order: string, status: string, root = id, replaces?: string) =>
    run(
      `INSERT INTO "InvoiceRequest" ("id","tenantId","orderId","issuerId","billingProfileId","requestedById","status","clientIdempotencyKey","snapshotEncrypted","rootRequestId","replacesInvoiceRequestId","sequential","updatedAt")
       VALUES ('${id}','t','${order}','i','bp','u','${status}','k-${id}','enc','${root}',${replaces ? `'${replaces}'` : 'NULL'},'${id.padStart(9, '0')}',now())`,
    );
  await oldRequest('rA', 'oA', 'AUTHORIZED');
  await oldRequest('rB', 'oB', 'PROCESSING');
  await oldRequest('rC', 'oC', 'REJECTED');
  await sriRequest('rC2', 'oC', 'AUTHORIZED', 'rC', 'rC');
  await oldRequest('rD1', 'oD', 'FAILED');
  await oldRequest('rD2', 'oD', 'FAILED', 'rD1', 'rD1');
  await sriRequest('rE1', 'oE', 'REJECTED');
  await oldRequest('rE2', 'oE', 'AUTHORIZED', 'rE1', 'rE1');
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
}

(disposable ? describe : describe.skip)('own SRI invoicing deletion migration', () => {
  jest.setTimeout(300000);

  describe('on test-environment documents', () => {
    let stage: Stage;
    let audit: Awaited<ReturnType<typeof auditFormerProviderRemoval>>;

    beforeAll(async () => {
      stage = new Stage();
      await stage.create();
      await seed(stage, '1');
      audit = await auditFormerProviderRemoval(stage.db);
      stage.apply();
    });
    afterAll(() => stage.drop());

    it('previews exactly what the migration changes, without blocking it', () => {
      expect(audit).toEqual({
        alreadyApplied: false,
        requestsByEnvironmentAndStatus: [
          { environment: '1', status: 'AUTHORIZED', requiresReconciliation: false, count: 2 },
          { environment: '1', status: 'FAILED', requiresReconciliation: false, count: 2 },
          { environment: '1', status: 'PROCESSING', requiresReconciliation: true, count: 1 },
          { environment: '1', status: 'REJECTED', requiresReconciliation: false, count: 1 },
        ],
        productionBlocking: 0,
        ordersToPaid: 3,
        sessionsToBillingFailed: 3,
        sriChainsRestarted: 1,
        deletedPerTenant: [
          { tenantId: 't', connections: 1, refs: 1, points: 1, requests: 6, events: 3 },
        ],
      });
    });

    it('deletes the former provider requests, events and points and keeps the SRI ones', async () => {
      expect(await stage.ids('InvoiceRequest')).toEqual(['rC2', 'rE1']);
      expect(await stage.ids('InvoiceRequestEvent')).toEqual(['evC2']);
      expect(await stage.ids('BranchEmissionPoint')).toEqual(['pt_new']);
    });

    it('returns orders without a blocking SRI request to PAID and fails their billed sessions', async () => {
      for (const key of ['A', 'B', 'E']) {
        expect(await stage.status('Order', `o${key}`)).toEqual({ status: 'PAID', version: 2 });
        expect(await stage.status('TreatmentSession', `s${key}`)).toEqual({
          status: 'BILLING_FAILED',
          version: 2,
        });
      }
      // An order with an authorized SRI request keeps its status, as do its sessions.
      expect(await stage.status('Order', 'oC')).toEqual({ status: 'INVOICED', version: 1 });
      expect(await stage.status('TreatmentSession', 'sC')).toEqual({
        status: 'BILLED',
        version: 1,
      });
      // An order already billable again is untouched.
      expect(await stage.status('Order', 'oD')).toEqual({ status: 'PAID', version: 1 });
      expect(await stage.status('TreatmentSession', 'sD')).toEqual({
        status: 'BILLING_FAILED',
        version: 1,
      });
    });

    it('starts an SRI chain that replaced a former provider request at itself', async () => {
      expect(
        await stage.one(
          `SELECT "id", "rootRequestId", "replacesInvoiceRequestId" FROM "InvoiceRequest" ORDER BY "id"`,
        ),
      ).toEqual({ id: 'rC2', rootRequestId: 'rC2', replacesInvoiceRequestId: null });
      expect(
        await stage.one(
          `SELECT "rootRequestId", "replacesInvoiceRequestId" FROM "InvoiceRequest" WHERE "id"='rE1'`,
        ),
      ).toEqual({ rootRequestId: 'rE1', replacesInvoiceRequestId: null });
    });

    it('drops the provider tables and columns', async () => {
      const tables = await stage.db.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public' AND table_name IN ('InvoicingConnection','InvoicingRef')`,
      );
      expect(tables).toEqual([]);
      const columns = await stage.db.$queryRawUnsafe<unknown[]>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema='public'
           AND table_name IN ('InvoiceRequest','InvoiceRequestEvent','BranchEmissionPoint')
           AND column_name IN ('connectionId','externalDocumentId','providerIdempotencyKey',
             'providerBodyEncrypted','providerBodyHash','requiresReconciliation','webhookEventId',
             'establishmentId','emissionPointId')`,
      );
      expect(columns).toEqual([]);
      const nullable = await stage.db.$queryRawUnsafe<unknown[]>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema='public' AND is_nullable='YES'
           AND ((table_name IN ('InvoiceRequest','InvoiceRequestEvent','BranchEmissionPoint')
                 AND column_name='issuerId')
             OR (table_name='BranchEmissionPoint' AND column_name='establishmentAddress'))`,
      );
      expect(nullable).toEqual([]);
    });

    it('keeps at most one pending or authorized request per order', async () => {
      expect(
        await stage.one(
          `SELECT indexdef FROM pg_indexes WHERE indexname='InvoiceRequest_one_blocking_per_order'`,
        ),
      ).toEqual({
        indexdef: expect.stringMatching(
          /^CREATE UNIQUE INDEX "InvoiceRequest_one_blocking_per_order" ON public\."InvoiceRequest" USING btree \("orderId"\) WHERE .*'REQUESTED'.*'PROCESSING'.*'AUTHORIZED'/,
        ),
      });
      await expect(
        stage.run(
          `INSERT INTO "InvoiceRequest" ("id","tenantId","orderId","issuerId","billingProfileId","requestedById","status","clientIdempotencyKey","snapshotEncrypted","rootRequestId","updatedAt")
           VALUES ('rC3','t','oC','i','bp','u','REQUESTED','k-rC3','enc','rC3',now())`,
        ),
      ).rejects.toThrow(/23505.*Key \(\\?"orderId\\?"\)=\(oC\) already exists/s);
    });

    it('reports an already applied removal', async () => {
      expect(await auditFormerProviderRemoval(stage.db)).toEqual({ alreadyApplied: true });
    });
  });

  describe('with a possibly real production document', () => {
    let stage: Stage;
    let failure: unknown;

    beforeAll(async () => {
      stage = new Stage();
      await stage.create();
      await seed(stage, '2');
      // A failed request whose outcome was uncertain also counts.
      await stage.run(`UPDATE "InvoiceRequest" SET "requiresReconciliation"=true WHERE "id"='rD2'`);
      try {
        stage.apply();
      } catch (error) {
        failure = error;
      }
    });
    afterAll(() => stage.drop());

    it('is flagged by the audit, which exits non-zero for it', async () => {
      const audit = await auditFormerProviderRemoval(stage.db);
      expect(audit).toMatchObject({ alreadyApplied: false, productionBlocking: 4 });
    });

    it('aborts the migration before changing anything', async () => {
      expect(String(failure)).toContain(
        'Former provider requests in the production environment are authorized or pending',
      );
      expect(await stage.ids('InvoiceRequest')).toEqual([
        'rA',
        'rB',
        'rC',
        'rC2',
        'rD1',
        'rD2',
        'rE1',
        'rE2',
      ]);
      expect(await stage.ids('InvoiceRequestEvent')).toEqual(['evA', 'evB', 'evC2', 'evOrphan']);
      expect(await stage.ids('BranchEmissionPoint')).toEqual(['pt_new', 'pt_old']);
      expect(await stage.status('Order', 'oA')).toEqual({ status: 'INVOICED', version: 1 });
      expect(await stage.status('TreatmentSession', 'sA')).toEqual({
        status: 'BILLED',
        version: 1,
      });
      expect(
        await stage.one(`SELECT to_regclass('"InvoicingConnection"') IS NOT NULL AS "present"`),
      ).toEqual({ present: true });
      expect(
        await stage.one(
          `SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name"='${TARGET}'`,
        ),
      ).toEqual({ finished_at: null });
    });
  });
});
