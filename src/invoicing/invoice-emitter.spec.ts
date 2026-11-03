import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { InvoiceEmitter } from './invoice-emitter';
import { FiscalSnapshot } from './invoice-snapshot';
import { InvoiceWorkerService } from './invoice-worker.service';
import { IssuerService } from './issuer.service';
import { SriError } from './sri/sri-types';
import { sampleDocument } from './sri/testing/sample-document';
import { createTestP12 } from './sri/testing/test-certificate';
import { verifyInvoiceSignature } from './sri/xades-verifier';

const tenant = 'clinic';
const ruc = '1790012345001';
const password = 'clave-prueba';
const crypto = new ClinicalCryptoService(
  new ConfigService({ CLINICAL_ENCRYPTION_KEYS: 'test:' + Buffer.alloc(32, 7).toString('base64') }),
);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const decrypt = (bytes: Buffer) => crypto.decryptBuffer(tenant, bytes);

function memoryStorage() {
  const files = new Map<string, Buffer>();
  return {
    put: jest.fn(async (key: string, data: Buffer) => void files.set(key, data)),
    get: (key: string) => files.get(key)!,
    remove: jest.fn(async (key: string) => void files.delete(key)),
    keys: () => [...files.keys()],
  };
}

function snapshot(): FiscalSnapshot {
  const doc = sampleDocument();
  return {
    customer: doc.customer,
    issuerId: 'issuer',
    issuer: doc.issuer,
    environment: '1',
    establishmentCode: '001',
    emissionPointCode: '002',
    establishmentAddress: doc.establishmentAddress,
    issueDate: '2026-10-07',
    lines: doc.lines,
    payments: doc.payments,
  };
}

describe('InvoiceEmitter preflight and signing', () => {
  let validP12: Buffer;
  let expiredP12: Buffer;
  let storage: ReturnType<typeof memoryStorage>;
  let issuer: any;
  let row: any;
  let sequence: { next: number } | null;
  let leaseLost: boolean;
  let commitFails: boolean;
  let stored: any;
  let events: any[];
  let prisma: any;
  let emitter: InvoiceEmitter;
  const deadline = () => Date.now() + 100000;
  const lastUpdate = () => prisma.updates.at(-1);

  beforeAll(() => {
    validP12 = createTestP12({ ruc, password });
    expiredP12 = createTestP12({
      ruc,
      password,
      validFrom: new Date('2020-01-01T00:00:00Z'),
      validTo: new Date('2021-01-01T00:00:00Z'),
    });
  }, 30000);

  beforeEach(() => {
    storage = memoryStorage();
    issuer = {
      id: 'issuer',
      tenantId: tenant,
      ruc,
      legalName: 'Clínica Ejemplo S.A.',
      tradeName: 'Clínica Ejemplo',
      environment: '1',
      active: true,
      certificateEncrypted: crypto.encryptBuffer(tenant, validP12).toString('base64'),
      certificatePasswordEncrypted: crypto.encrypt(tenant, password),
    };
    row = {
      id: 'request',
      tenantId: tenant,
      orderId: 'order',
      issuerId: 'issuer',
      status: 'REQUESTED',
      attempts: 0,
      snapshotEncrypted: crypto.encrypt(tenant, JSON.stringify(snapshot())),
      signedXmlStorageKey: null,
      leaseToken: 'lease',
      leaseUntil: new Date(Date.now() + 120000),
      requestedAt: new Date(),
    };
    sequence = { next: 500 };
    leaseLost = false;
    commitFails = false;
    stored = { ...row };
    events = [];
    prisma = {
      updates: [] as any[],
      invoiceRequest: {
        findFirst: jest.fn(async ({ where }: any) =>
          stored.id === where.id && stored.signedXmlStorageKey === where.signedXmlStorageKey
            ? { id: stored.id }
            : null,
        ),
      },
      invoicingIssuer: { findUnique: jest.fn(async () => issuer) },
      branchEmissionPoint: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.issuerId === 'issuer' &&
          where.establishmentCode === '001' &&
          where.emissionPointCode === '002'
            ? { id: 'point' }
            : null,
        ),
      },
      // Writes are staged and only kept when the callback resolves, like a real rollback.
      $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
        const staged = {
          sequence: sequence ? { ...sequence } : null,
          events: [] as any[],
          row: { ...stored },
        };
        const tx = {
          $queryRaw: jest.fn(async () => {
            if (!staged.sequence) return [];
            staged.sequence.next += 1;
            return [{ sequential: staged.sequence.next - 1 }];
          }),
          invoiceSequence: {
            create: jest.fn(async ({ data }: any) => (staged.sequence = { next: data.next })),
          },
          invoiceRequest: {
            updateMany: jest.fn(async (args: any) => {
              prisma.updates.push(args);
              if (leaseLost) return { count: 0 };
              Object.assign(staged.row, args.data);
              return { count: 1 };
            }),
          },
          invoiceRequestEvent: {
            create: jest.fn(async ({ data }: any) => staged.events.push(data)),
          },
        };
        const result = await fn(tx);
        sequence = staged.sequence;
        events.push(...staged.events);
        stored = staged.row;
        // The connection drops while COMMIT is in flight: PostgreSQL committed, Prisma rejects.
        if (commitFails) throw new Error('connection lost during commit');
        return result;
      }),
    };
    const issuers = new IssuerService(prisma, crypto, {} as any);
    emitter = new InvoiceEmitter(prisma, crypto, issuers, storage as any);
  });

  it('fails safely before signing when the certificate expired', async () => {
    issuer.certificateEncrypted = crypto.encryptBuffer(tenant, expiredP12).toString('base64');
    await expect(emitter.advance(row, deadline())).rejects.toMatchObject({
      kind: 'configuration',
      code: 'CERTIFICATE_EXPIRED',
    });
    expect(storage.keys()).toHaveLength(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['an inactive issuer', () => (issuer.active = false), 'INVOICING_NOT_CONFIGURED'],
    [
      'a missing certificate',
      () => (issuer.certificateEncrypted = null),
      'INVOICING_CERTIFICATE_REQUIRED',
    ],
    ['a changed environment', () => (issuer.environment = '2'), 'INVOICING_ENVIRONMENT_CHANGED'],
    ['a removed emission point', () => (issuer.id = 'other'), 'INVOICING_NOT_CONFIGURED'],
  ])('refuses %s before reserving a sequential', async (_label, change, code) => {
    change();
    await expect(emitter.advance(row, deadline())).rejects.toMatchObject({
      kind: 'configuration',
      code,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sequence).toEqual({ next: 500 });
  });

  it('refuses a certificate issued to another RUC', async () => {
    const other = createTestP12({ ruc: '0990012345001', password });
    issuer.certificateEncrypted = crypto.encryptBuffer(tenant, other).toString('base64');
    await expect(emitter.advance(row, deadline())).rejects.toMatchObject({
      kind: 'configuration',
      code: 'CERTIFICATE_RUC_MISMATCH',
    });
    expect(storage.keys()).toHaveLength(0);
  }, 30000);

  it('reserves the sequence, signs, verifies and stores the signed XML in one leased transaction', async () => {
    await emitter.advance(row, deadline());

    const { where, data } = lastUpdate();
    expect(where).toMatchObject({
      id: 'request',
      leaseToken: 'lease',
      leaseUntil: { gt: expect.any(Date) },
      signedXmlStorageKey: null,
    });
    expect(data).toMatchObject({
      sequential: '000000500',
      number: '001-002-000000500',
      externalState: 'SIGNED',
      status: 'PROCESSING',
    });
    expect(data.accessKey.slice(0, 8)).toBe('07102026');
    expect(data.accessKey.slice(24, 39)).toBe('001002000000500');
    expect(data.signedXmlStorageKey).toMatch(/^invoices\/clinic\/request\/signed-[0-9a-f-]{36}$/);
    const xml = decrypt(storage.get(data.signedXmlStorageKey));
    expect(verifyInvoiceSignature(xml.toString('utf8')).valid).toBe(true);
    expect(xml.toString('utf8')).toContain(`<claveAcceso>${data.accessKey}</claveAcceso>`);
    expect(data.signedXmlSha256).toBe(sha256(xml));
    expect(sequence).toEqual({ next: 501 });
    expect(events).toEqual([
      expect.objectContaining({
        issuerId: 'issuer',
        connectionId: null,
        invoiceRequestId: 'request',
        type: 'SIGNED',
      }),
    ]);
  });

  it('starts a sequence at 1 when the point has none in this environment', async () => {
    sequence = null;
    await emitter.advance(row, deadline());
    expect(lastUpdate().data.sequential).toBe('000000001');
    expect(sequence).toEqual({ next: 2 });
  });

  it('removes the stored file and keeps the sequence when the lease is lost before commit', async () => {
    leaseLost = true;
    await expect(emitter.advance(row, deadline())).resolves.toBeUndefined();
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
    expect(storage.keys()).toHaveLength(0);
    expect(sequence).toEqual({ next: 500 });
    expect(events).toEqual([]);
  });

  it('removes the stored file when the transaction fails after storing it', async () => {
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      await fn({
        $queryRaw: async () => [{ sequential: 500 }],
        invoiceSequence: { create: jest.fn() },
        invoiceRequest: { updateMany: async () => ({ count: 1 }) },
        invoiceRequestEvent: {
          create: async () => {
            throw new Error('connection reset');
          },
        },
      });
    });
    await expect(emitter.advance(row, deadline())).rejects.toThrow('connection reset');
    expect(storage.keys()).toHaveLength(0);
  });

  it('keeps the signed file when the commit may have succeeded', async () => {
    commitFails = true;
    await expect(emitter.advance(row, deadline())).rejects.toThrow('connection lost');
    expect(stored.signedXmlStorageKey).toMatch(/^invoices\/clinic\/request\/signed-/);
    expect(storage.remove).not.toHaveBeenCalled();
    const xml = decrypt(storage.get(stored.signedXmlStorageKey));
    expect(sha256(xml)).toBe(stored.signedXmlSha256);
  });

  it('keeps the signed file when it cannot confirm that the row does not reference it', async () => {
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      await fn({
        $queryRaw: async () => [{ sequential: 500 }],
        invoiceSequence: { create: jest.fn() },
        invoiceRequest: { updateMany: async () => ({ count: 1 }) },
        invoiceRequestEvent: { create: jest.fn() },
      });
      throw new Error('connection lost during commit');
    });
    prisma.invoiceRequest.findFirst.mockRejectedValue(new Error('database unreachable'));
    await expect(emitter.advance(row, deadline())).rejects.toThrow('connection lost');
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.keys()).toHaveLength(1);
  });

  it('refuses an issuer of another tenant without signing or touching the sequence', async () => {
    issuer.tenantId = 'other-clinic';
    await expect(emitter.advance(row, deadline())).rejects.toMatchObject({
      kind: 'configuration',
      code: 'INVOICING_NOT_CONFIGURED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(sequence).toEqual({ next: 500 });
    expect(stored.signedXmlStorageKey).toBeNull();
  });

  it('never re-signs a row that already has signed XML', async () => {
    row.signedXmlStorageKey = 'invoices/clinic/request/signed-existing';
    row.status = 'PROCESSING';
    await emitter.advance(row, deadline());
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.invoicingIssuer.findUnique).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('does not start signing past the deadline', async () => {
    await emitter.advance(row, Date.now() - 1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('signs from the snapshot even if the issuer was edited afterwards', async () => {
    issuer.legalName = 'Razon Social Editada';
    issuer.tradeName = 'Nombre Editado';
    await emitter.advance(row, deadline());
    const xml = decrypt(storage.get(lastUpdate().data.signedXmlStorageKey)).toString('utf8');
    expect(xml).toContain('<razonSocial>Clínica Ejemplo S.A.</razonSocial>');
    expect(xml).not.toContain('Editad');
  });
});

describe('InvoiceWorkerService', () => {
  let tx: any;
  let prisma: any;
  let emitter: { advance: jest.Mock };
  let worker: InvoiceWorkerService;
  const leased = (extra: Record<string, unknown> = {}) => ({
    id: 'request',
    tenantId: tenant,
    orderId: 'order',
    issuerId: 'issuer',
    status: 'REQUESTED',
    attempts: 0,
    signedXmlStorageKey: null,
    leaseToken: 'lease',
    leaseUntil: new Date(Date.now() + 120000),
    requestedAt: new Date(),
    ...extra,
  });

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      invoiceRequest: {
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      invoiceRequestEvent: { create: jest.fn() },
      order: { update: jest.fn() },
      treatmentSession: { updateMany: jest.fn() },
    };
    prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    emitter = { advance: jest.fn() };
    worker = new InvoiceWorkerService(prisma, crypto, emitter as any);
  });

  it('hands each claimed row to the emitter with a deadline inside the lease', async () => {
    const row = leased();
    await worker.process(row as any);
    expect(emitter.advance).toHaveBeenCalledWith(row, expect.any(Number));
    const deadline = emitter.advance.mock.calls[0][1];
    expect(deadline - Date.now()).toBeGreaterThan(90000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(100000);
    expect(tx.invoiceRequest.updateMany).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'claims only rows of a local issuer (reconcile: %s)',
    async (reconcile) => {
      await worker.claim(reconcile);
      const sql: string = tx.$queryRaw.mock.calls[0][0].sql;
      expect(sql).toContain('"issuerId" IS NOT NULL');
      expect(sql).not.toContain('externalDocumentId');
      expect(sql).toContain(
        reconcile ? `"status" = 'PROCESSING'` : `"status" IN ('REQUESTED','PROCESSING')`,
      );
    },
  );

  it('keeps a signed row PROCESSING on a configuration error and does not release the order', async () => {
    const row = leased({ status: 'PROCESSING', signedXmlStorageKey: 'invoices/clinic/request/x' });
    tx.invoiceRequest.findFirst.mockResolvedValue(row);
    emitter.advance.mockRejectedValue(new SriError('configuration', 'CERTIFICATE_EXPIRED'));

    await worker.process(row as any);

    const { where, data } = tx.invoiceRequest.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({ id: 'request', leaseToken: 'lease' });
    expect(data).toMatchObject({ status: 'PROCESSING', leaseToken: null, finishedAt: null });
    expect(data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(JSON.parse(crypto.decrypt(tenant, data.lastErrorEncrypted))).toEqual({
      code: 'CERTIFICATE_EXPIRED',
    });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.treatmentSession.updateMany).not.toHaveBeenCalled();
    expect(tx.invoiceRequestEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        issuerId: 'issuer',
        connectionId: null,
        type: 'RETRY_SCHEDULED',
        detail: { code: 'CERTIFICATE_EXPIRED' },
      }),
    });
  });

  it('trusts the stored row over the claimed copy when the row was signed during this pass', async () => {
    const row = leased();
    tx.invoiceRequest.findFirst.mockResolvedValue({
      ...row,
      status: 'PROCESSING',
      signedXmlStorageKey: 'invoices/clinic/request/x',
    });
    emitter.advance.mockRejectedValue(new SriError('configuration', 'CERTIFICATE_EXPIRED'));

    await worker.process(row as any);

    expect(tx.invoiceRequest.updateMany.mock.calls[0][0].data.status).toBe('PROCESSING');
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it('fails an unsigned row on a configuration error and releases the order', async () => {
    const row = leased();
    tx.invoiceRequest.findFirst.mockResolvedValue(row);
    emitter.advance.mockRejectedValue(new SriError('configuration', 'CERTIFICATE_EXPIRED'));

    await worker.process(row as any);

    const { data } = tx.invoiceRequest.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ status: 'FAILED', finishedAt: expect.any(Date) });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'order' },
      data: { status: 'PAID', version: { increment: 1 } },
    });
    expect(tx.treatmentSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'BILLING_FAILED', version: { increment: 1 } } }),
    );
    expect(tx.invoiceRequestEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'FAILED', issuerId: 'issuer', connectionId: null }),
    });
  });

  it('retries an unsigned row on a transient error until 24 hours have passed', async () => {
    const fresh = leased();
    tx.invoiceRequest.findFirst.mockResolvedValue(fresh);
    emitter.advance.mockRejectedValue(new Error('socket hang up'));
    await worker.process(fresh as any);
    expect(tx.invoiceRequest.updateMany.mock.calls[0][0].data.status).toBe('REQUESTED');
    expect(tx.order.update).not.toHaveBeenCalled();

    const old = leased({ requestedAt: new Date(Date.now() - 86400001) });
    tx.invoiceRequest.findFirst.mockResolvedValue(old);
    await worker.process(old as any);
    expect(tx.invoiceRequest.updateMany.mock.calls[1][0].data.status).toBe('FAILED');
    expect(tx.order.update).toHaveBeenCalledTimes(1);
  });

  it('keeps a signed row PROCESSING on a transient error after 24 hours', async () => {
    const row = leased({
      status: 'PROCESSING',
      signedXmlStorageKey: 'invoices/clinic/request/x',
      sequential: '000000500',
      requestedAt: new Date(Date.now() - 2 * 86400000),
    });
    tx.invoiceRequest.findFirst.mockResolvedValue(row);
    emitter.advance.mockRejectedValue(new SriError('transient', 'SRI_UNAVAILABLE'));

    await worker.process(row as any);

    const { data } = tx.invoiceRequest.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ status: 'PROCESSING', finishedAt: null });
    expect(data).not.toHaveProperty('signedXmlStorageKey');
    expect(data).not.toHaveProperty('sequential');
    expect(data).not.toHaveProperty('accessKey');
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.treatmentSession.updateMany).not.toHaveBeenCalled();
    expect(tx.invoiceRequestEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'RETRY_SCHEDULED' }),
    });
  });

  it('does nothing when the lease was lost before recording the failure', async () => {
    const row = leased();
    tx.invoiceRequest.findFirst.mockResolvedValue(null);
    emitter.advance.mockRejectedValue(new SriError('configuration', 'CERTIFICATE_EXPIRED'));
    await worker.process(row as any);
    expect(tx.invoiceRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});
