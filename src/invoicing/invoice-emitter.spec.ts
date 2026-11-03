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
  let orders: any[];
  let sessions: any[];
  let prisma: any;
  let sri: { send: jest.Mock; authorize: jest.Mock };
  let artifacts: { collect: jest.Mock };
  let delivery: { deliver: jest.Mock };
  let emitter: InvoiceEmitter;
  // Enough to sign, under the 4 s needed to start an SRI call: signing tests stop before sending.
  const deadline = () => Date.now() + 3000;
  const lastUpdate = () => prisma.updates.at(-1);
  const matches = (target: any, where: any) =>
    Object.entries<any>(where).every(([field, value]) =>
      value && typeof value === 'object' && 'gt' in value
        ? !!target[field] && target[field] > value.gt
        : target[field] === value,
    );
  const apply = (target: any, data: any) => {
    for (const [field, value] of Object.entries<any>(data))
      target[field] =
        value && typeof value === 'object' && 'increment' in value
          ? target[field] + value.increment
          : value;
  };

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
    orders = [];
    sessions = [];
    prisma = {
      updates: [] as any[],
      invoiceRequest: {
        findFirst: jest.fn(async ({ where }: any) =>
          matches(stored, where) ? { ...stored } : null,
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (!matches(stored, where)) return { count: 0 };
          apply(stored, data);
          return { count: 1 };
        }),
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
          orders: [] as any[],
          sessions: [] as any[],
          row: { ...stored },
        };
        const tx = {
          $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
            // SELECT ... FOR UPDATE of the request row.
            if (!sql.join('').includes('"InvoiceSequence"')) return [{ ...staged.row }];
            if (!staged.sequence) return [];
            staged.sequence.next += 1;
            return [{ sequential: staged.sequence.next - 1 }];
          }),
          invoiceSequence: {
            create: jest.fn(async ({ data }: any) => (staged.sequence = { next: data.next })),
          },
          invoiceRequest: {
            findFirst: jest.fn(async ({ where }: any) =>
              matches(staged.row, where) ? { ...staged.row } : null,
            ),
            update: jest.fn(async (args: any) => {
              prisma.updates.push(args);
              apply(staged.row, args.data);
              return { ...staged.row };
            }),
            updateMany: jest.fn(async (args: any) => {
              prisma.updates.push(args);
              if (leaseLost || !matches(staged.row, args.where)) return { count: 0 };
              apply(staged.row, args.data);
              return { count: 1 };
            }),
          },
          invoiceRequestEvent: {
            create: jest.fn(async ({ data }: any) => staged.events.push(data)),
          },
          order: { update: jest.fn(async (args: any) => staged.orders.push(args)) },
          treatmentSession: {
            updateMany: jest.fn(async (args: any) => staged.sessions.push(args)),
          },
        };
        const result = await fn(tx);
        sequence = staged.sequence;
        events.push(...staged.events);
        orders.push(...staged.orders);
        sessions.push(...staged.sessions);
        stored = staged.row;
        // The connection drops while COMMIT is in flight: PostgreSQL committed, Prisma rejects.
        if (commitFails) throw new Error('connection lost during commit');
        return result;
      }),
    };
    const issuers = new IssuerService(prisma, crypto, {} as any);
    sri = { send: jest.fn(), authorize: jest.fn() };
    artifacts = { collect: jest.fn() };
    delivery = { deliver: jest.fn() };
    emitter = new InvoiceEmitter(
      prisma,
      crypto,
      issuers,
      storage as any,
      sri as any,
      artifacts as any,
      delivery as any,
    );
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

  describe('reception and authorization', () => {
    // date, codDoc 01, RUC, environment, series, sequential, numeric code, emission type, check digit
    const accessKey = `0710202601${ruc}1001002000000500123456781` + '7';
    const signedXml = Buffer.from('<factura id="comprobante">firmada</factura>', 'utf8');
    const received = { outcome: 'RECEIVED', sriStatus: 'RECIBIDA', messages: [] };
    const unknown = {
      outcome: 'PENDING',
      sriStatus: null,
      authorizationNumber: null,
      authorizedAt: null,
      environmentLabel: null,
      messages: [],
    };
    const authorized = {
      outcome: 'AUTHORIZED',
      sriStatus: 'AUTORIZADO',
      authorizationNumber: `0710202601${ruc}1001002000000500123456781` + '7',
      authorizedAt: new Date('2026-10-07T15:04:05-05:00'),
      environmentLabel: 'PRUEBAS',
      messages: [],
    };
    const message = (identifier: string) => ({
      identifier,
      message: 'texto del SRI',
      additionalInfo: null,
      type: 'ERROR',
    });
    const returned = (...identifiers: string[]) => ({
      outcome: 'RETURNED',
      sriStatus: 'DEVUELTA',
      messages: identifiers.map(message),
    });
    let unsigned: any;
    let worker: InvoiceWorkerService;

    /** Runs advance to completion, letting the inline 3 s waits elapse on the fake clock. */
    const run = async (target: any = row, until = Date.now() + 100000) => {
      const outcome = emitter.advance(target, until).then(
        () => undefined,
        (error: unknown) => error,
      );
      await jest.runAllTimersAsync();
      return outcome;
    };

    /** An integrity failure stops the row for intervention: no claim selects it any more. */
    const expectHalted = () => {
      expect(sri.send).not.toHaveBeenCalled();
      expect(stored).toMatchObject({
        status: 'PROCESSING',
        externalState: 'SIGNED',
        signedXmlStorageKey: row.signedXmlStorageKey,
        accessKey,
        leaseToken: null,
        leaseUntil: null,
        finishedAt: null,
        nextAttemptAt: new Date('9999-12-31T00:00:00Z'),
      });
      expect(JSON.parse(crypto.decrypt(tenant, stored.lastErrorEncrypted))).toEqual({
        code: 'INVOICE_SIGNED_XML_INTEGRITY',
      });
      expect(orders).toEqual([]);
      expect(sessions).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: 'INTEGRITY_HALTED',
        detail: { code: 'INVOICE_SIGNED_XML_INTEGRITY' },
      });
      expect(events.map((e) => e.type)).not.toContain('RETRY_SCHEDULED');
    };

    beforeEach(async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      unsigned = { ...row };
      const key = 'invoices/clinic/request/signed-existing';
      await storage.put(key, crypto.encryptBuffer(tenant, signedXml));
      storage.put.mockClear();
      Object.assign(row, {
        status: 'PROCESSING',
        externalState: 'SIGNED',
        attempts: 2,
        sequential: '000000500',
        number: '001-002-000000500',
        accessKey,
        signedXmlStorageKey: key,
        signedXmlSha256: sha256(signedXml),
        lastErrorEncrypted: null,
      });
      stored = { ...row };
      worker = new InvoiceWorkerService(prisma, crypto, emitter);
    });

    afterEach(() => jest.useRealTimers());

    it('asks for the authorization before resending a row that was already sent', async () => {
      sri.authorize.mockResolvedValueOnce(unknown).mockResolvedValue(authorized);
      sri.send.mockResolvedValue(received);

      expect(await run()).toBeUndefined();

      expect(sri.authorize).toHaveBeenNthCalledWith(1, '1', accessKey, { timeoutMs: 15000 });
      expect(sri.authorize.mock.invocationCallOrder[0]).toBeLessThan(
        sri.send.mock.invocationCallOrder[0],
      );
      expect(sri.send).toHaveBeenCalledTimes(1);
      expect(stored.status).toBe('AUTHORIZED');
    });

    it('applies an authorization found before sending without sending again', async () => {
      sri.authorize.mockResolvedValue(authorized);
      await run();
      expect(sri.send).not.toHaveBeenCalled();
      expect(stored).toMatchObject({ status: 'AUTHORIZED', externalState: 'AUTHORIZED' });
    });

    it('follows a voucher the SRI is already processing without sending it again', async () => {
      sri.authorize
        .mockResolvedValueOnce({ ...unknown, sriStatus: 'EN PROCESO' })
        .mockResolvedValue(authorized);
      await run();
      expect(sri.send).not.toHaveBeenCalled();
      expect(sri.authorize).toHaveBeenCalledTimes(2);
      expect(stored.status).toBe('AUTHORIZED');
    });

    it('follows a received row by its access key without sending it again', async () => {
      row.externalState = 'RECEIVED';
      stored = { ...row };
      sri.authorize.mockResolvedValue(authorized);
      const start = Date.now();
      await run();
      expect(sri.send).not.toHaveBeenCalled();
      expect(sri.authorize).toHaveBeenCalledTimes(1);
      // A resumed row is queried right away; the 3 s wait only follows a send or a pending answer.
      expect(Date.now()).toBe(start);
      expect(stored.status).toBe('AUTHORIZED');
    });

    it('sends the exact stored bytes and refuses them if their SHA-256 changed', async () => {
      sri.authorize.mockResolvedValueOnce(unknown).mockResolvedValue(authorized);
      sri.send.mockResolvedValue(received);
      await run();
      expect(sri.send).toHaveBeenCalledWith('1', signedXml, { timeoutMs: 15000 });

      sri.send.mockClear();
      sri.authorize.mockReset().mockResolvedValue(unknown);
      const tampered = {
        ...row,
        signedXmlSha256: sha256(Buffer.from('<factura>otra</factura>')),
      };
      stored = { ...tampered };
      events.length = 0;
      sessions.length = 0;
      expect(await run(tampered)).toMatchObject({
        kind: 'configuration',
        code: 'INVOICE_SIGNED_XML_INTEGRITY',
      });
      expect(sri.send).not.toHaveBeenCalled();
      expect(stored).toEqual(tampered);

      await worker.process(tampered as any);
      expectHalted();
      expect(stored.signedXmlSha256).toBe(tampered.signedXmlSha256);
    });

    it('retries with backoff when the signed file cannot be read from storage', async () => {
      // Storage drivers throw plain errors: a missing file looks like an outage, so it never halts.
      (storage as any).get = jest.fn().mockRejectedValue(new Error('object not found'));
      sri.authorize.mockResolvedValue(unknown);
      expect(await run()).toMatchObject({
        kind: 'transient',
        code: 'INVOICE_SIGNED_XML_UNAVAILABLE',
      });

      await worker.process(row);

      expect(sri.send).not.toHaveBeenCalled();
      expect(stored).toMatchObject({
        status: 'PROCESSING',
        externalState: 'SIGNED',
        signedXmlStorageKey: row.signedXmlStorageKey,
        leaseToken: null,
        attempts: 3,
      });
      // retryDelay(3) = 2 min: a normal backoff, not the halt sentinel.
      expect(stored.nextAttemptAt.getTime()).toBe(Date.now() + 120000);
      expect(JSON.parse(crypto.decrypt(tenant, stored.lastErrorEncrypted))).toEqual({
        code: 'INVOICE_SIGNED_XML_UNAVAILABLE',
      });
      expect(orders).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(['RETRY_SCHEDULED']);
    });

    it('retries a stored file that no longer decrypts without sending it', async () => {
      const ciphertext = storage.get(row.signedXmlStorageKey);
      ciphertext[ciphertext.length - 1] ^= 1;
      sri.authorize.mockResolvedValue(unknown);
      expect(await run()).toMatchObject({
        kind: 'transient',
        code: 'INVOICE_SIGNED_XML_UNAVAILABLE',
      });
      expect(sri.send).not.toHaveBeenCalled();
    });

    it.each(['43', '70'])('treats DEVUELTA with message %s as received', async (identifier) => {
      sri.authorize.mockResolvedValue(unknown);
      sri.send.mockResolvedValue(returned(identifier));

      expect(await run()).toBeUndefined();

      expect(stored).toMatchObject({
        status: 'PROCESSING',
        externalState: 'RECEIVED',
        lastErrorEncrypted: null,
        leaseToken: null,
      });
      expect(stored.finishedAt).toBeUndefined();
      expect(orders).toEqual([]);
      expect(sessions).toEqual([]);
      expect(events).toEqual([expect.objectContaining({ type: 'RECEIVED', issuerId: 'issuer' })]);
    });

    it('rejects on any other DEVUELTA, stores the SRI messages encrypted and releases the order', async () => {
      const answer = returned('35', '26');
      sri.authorize.mockResolvedValue(unknown);
      sri.send.mockResolvedValue(answer);

      expect(await run()).toBeUndefined();

      expect(stored).toMatchObject({
        status: 'REJECTED',
        externalState: 'RETURNED',
        leaseToken: null,
        leaseUntil: null,
        finishedAt: expect.any(Date),
      });
      expect(JSON.parse(crypto.decrypt(tenant, stored.lastErrorEncrypted))).toEqual({
        code: 'SRI_REJECTED',
        messages: answer.messages,
      });
      expect(orders).toEqual([
        { where: { id: 'order' }, data: { status: 'PAID', version: { increment: 1 } } },
      ]);
      expect(sessions).toEqual([
        expect.objectContaining({ data: { status: 'BILLING_FAILED', version: { increment: 1 } } }),
      ]);
      expect(sri.authorize).toHaveBeenCalledTimes(1);
      expect(events).toEqual([expect.objectContaining({ type: 'REJECTED' })]);
      expect(JSON.stringify(events)).not.toContain('texto del SRI');
    });

    describe('after the authorization', () => {
      const stores = () =>
        Object.assign(stored, {
          xmlStorageKey: 'xml',
          rideStorageKey: 'ride',
        });

      it('stores the files and sends the e-mail under the same lease, then frees the row', async () => {
        stored = { ...unsigned };
        sri.authorize.mockResolvedValueOnce(unknown).mockResolvedValue(authorized);
        sri.send.mockResolvedValue(received);
        artifacts.collect.mockImplementation(async (claimed: any) => {
          expect(claimed).toMatchObject({ status: 'AUTHORIZED', leaseToken: 'lease' });
          stores();
        });
        delivery.deliver.mockImplementation(async () => {
          expect(stored.leaseToken).toBe('lease');
          stored.emailedAt = new Date();
        });

        await run(unsigned);

        expect(artifacts.collect).toHaveBeenCalledTimes(1);
        expect(artifacts.collect.mock.calls[0][0]).toMatchObject({
          number: '001-002-000000500',
          authorizationNumber: authorized.authorizationNumber,
          authorizedAt: authorized.authorizedAt,
        });
        expect(artifacts.collect.mock.invocationCallOrder[0]).toBeLessThan(
          delivery.deliver.mock.invocationCallOrder[0],
        );
        expect(stored).toMatchObject({ leaseToken: null, leaseUntil: null, attempts: 0 });
        expect(events.map((e) => e.type)).toEqual(['SIGNED', 'RECEIVED', 'AUTHORIZED']);
      });

      it('schedules a backoff when a file is still missing', async () => {
        sri.authorize.mockResolvedValue(authorized);
        await run();
        expect(stored).toMatchObject({ status: 'AUTHORIZED', leaseToken: null, attempts: 3 });
        expect(stored.nextAttemptAt.getTime()).toBe(Date.now() + 30000 * 2 ** 2);
      });

      it('leaves the schedule alone when the row has nothing pending', async () => {
        sri.authorize.mockResolvedValue(authorized);
        delivery.deliver.mockImplementation(async () => {
          stores();
          stored.emailAttempts = 5;
        });
        const before = Date.now();
        await run();
        expect(stored).toMatchObject({ leaseToken: null, attempts: 2 });
        expect(stored.nextAttemptAt.getTime()).toBe(before);
      });

      it('keeps the retry that a failed e-mail already scheduled', async () => {
        sri.authorize.mockResolvedValue(authorized);
        const retryAt = new Date(Date.now() + 60000);
        delivery.deliver.mockImplementation(async () => {
          stores();
          Object.assign(stored, { emailAttempts: 1, nextAttemptAt: retryAt });
        });
        await run();
        expect(stored).toMatchObject({ leaseToken: null, attempts: 2 });
        expect(stored.nextAttemptAt).toBe(retryAt);
      });

      it('resumes a claimed authorized row without calling the SRI', async () => {
        Object.assign(row, {
          status: 'AUTHORIZED',
          externalState: 'AUTHORIZED',
          number: '001-002-000000500',
          authorizationNumber: authorized.authorizationNumber,
          authorizedAt: authorized.authorizedAt,
        });
        stored = { ...row, emailAttempts: 1, nextAttemptAt: new Date(Date.now() - 1000) };
        await run();
        expect(sri.authorize).not.toHaveBeenCalled();
        expect(sri.send).not.toHaveBeenCalled();
        expect(artifacts.collect).toHaveBeenCalledWith(row);
        expect(delivery.deliver).toHaveBeenCalledWith(row);
        expect(stored.leaseToken).toBeNull();
        expect(stored.nextAttemptAt.getTime()).toBe(Date.now() + 30000 * 2 ** 2);
      });

      it('only frees the row when less than 4 s of budget remain', async () => {
        sri.authorize.mockResolvedValue(authorized);
        const deadline = Date.now() + 5000;
        artifacts.collect.mockImplementation(async () => jest.setSystemTime(Date.now() + 2000));
        await run(row, deadline);
        expect(artifacts.collect).toHaveBeenCalledTimes(1);
        expect(delivery.deliver).not.toHaveBeenCalled();
        expect(stored.leaseToken).toBeNull();
      });

      it.each([
        ['collect', () => artifacts.collect.mockRejectedValue(new Error('storage down'))],
        ['deliver', () => delivery.deliver.mockRejectedValue(new Error('db down'))],
      ])('keeps the row AUTHORIZED, untouched and backed off when %s throws', async (_s, fail) => {
        sri.authorize.mockResolvedValue(authorized);
        fail();
        expect(await run()).toBeUndefined();
        expect(stored).toMatchObject({
          status: 'AUTHORIZED',
          leaseToken: null,
          leaseUntil: null,
          finishedAt: expect.any(Date),
          lastErrorEncrypted: null,
          attempts: 3,
        });
        expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        expect(events.map((e) => e.type)).toEqual(['AUTHORIZED']);
      });

      it('swallows a failing release: the lease just expires', async () => {
        sri.authorize.mockResolvedValue(authorized);
        prisma.invoiceRequest.findFirst.mockRejectedValue(new Error('db down'));
        expect(await run()).toBeUndefined();
        expect(stored.status).toBe('AUTHORIZED');
        expect(stored.lastErrorEncrypted).toBeNull();
      });

      it('does not touch a row whose lease was lost', async () => {
        sri.authorize.mockResolvedValue(authorized);
        artifacts.collect.mockImplementation(async () => {
          stored.leaseToken = 'other';
        });
        await run();
        expect(stored.leaseToken).toBe('other');
        expect(stored.attempts).toBe(2);
      });
    });

    it('authorizes with number and date and bills the sessions', async () => {
      stored = { ...unsigned };
      sri.authorize.mockResolvedValueOnce(unknown).mockResolvedValue(authorized);
      sri.send.mockResolvedValue(received);

      expect(await run(unsigned)).toBeUndefined();

      expect(stored).toMatchObject({
        status: 'AUTHORIZED',
        externalState: 'AUTHORIZED',
        number: '001-002-000000500',
        authorizationNumber: authorized.authorizationNumber,
        authorizedAt: authorized.authorizedAt,
        lastErrorEncrypted: null,
        leaseToken: null,
        leaseUntil: null,
        finishedAt: expect.any(Date),
      });
      expect(sri.authorize).toHaveBeenNthCalledWith(1, '1', stored.accessKey, {
        timeoutMs: 15000,
      });
      expect(sri.send).toHaveBeenCalledWith('1', decrypt(storage.get(stored.signedXmlStorageKey)), {
        timeoutMs: 15000,
      });
      expect(sessions).toEqual([
        {
          where: {
            tenantId: tenant,
            completedAt: { not: null },
            orderItems: { some: { orderId: 'order', releasedAt: null } },
          },
          data: { status: 'BILLED', version: { increment: 1 } },
        },
      ]);
      expect(orders).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(['SIGNED', 'RECEIVED', 'AUTHORIZED']);
    });

    it('rejects on NO AUTORIZADO', async () => {
      const notAuthorized = {
        ...unknown,
        outcome: 'NOT_AUTHORIZED',
        sriStatus: 'NO AUTORIZADO',
        authorizedAt: new Date('2026-10-07T15:04:05-05:00'),
        messages: [message('39')],
      };
      sri.authorize.mockResolvedValueOnce(unknown).mockResolvedValue(notAuthorized);
      sri.send.mockResolvedValue(received);

      await run();

      expect(stored).toMatchObject({
        status: 'REJECTED',
        externalState: 'NOT_AUTHORIZED',
        leaseToken: null,
        finishedAt: expect.any(Date),
      });
      expect(stored.authorizationNumber).toBeUndefined();
      expect(JSON.parse(crypto.decrypt(tenant, stored.lastErrorEncrypted))).toEqual({
        code: 'SRI_REJECTED',
        messages: notAuthorized.messages,
      });
      expect(orders).toHaveLength(1);
      expect(sessions).toEqual([
        expect.objectContaining({ data: { status: 'BILLING_FAILED', version: { increment: 1 } } }),
      ]);
      expect(events.map((e) => e.type)).toEqual(['RECEIVED', 'REJECTED']);
    });

    it('polls twice inline then leaves PENDING for the tick', async () => {
      const calls: number[] = [];
      sri.authorize.mockImplementation(async () => {
        calls.push(Date.now());
        return unknown;
      });
      sri.send.mockResolvedValue(received);
      const start = Date.now();

      expect(await run()).toBeUndefined();

      expect(calls.map((t) => t - start)).toEqual([0, 3000, 6000]);
      expect(stored).toMatchObject({
        status: 'PROCESSING',
        externalState: 'RECEIVED',
        attempts: 3,
        leaseToken: null,
        leaseUntil: null,
      });
      expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(orders).toEqual([]);
    });

    it('stops at the deadline without starting a new SRI call', async () => {
      // The authorization query takes 7 s: 3 s are left afterwards, under the 4 s minimum.
      sri.authorize.mockImplementation(async () => {
        jest.setSystemTime(Date.now() + 7000);
        return unknown;
      });
      const until = Date.now() + 10000;

      expect(await run(row, until)).toBeUndefined();

      expect(sri.authorize).toHaveBeenCalledTimes(1);
      expect(sri.authorize).toHaveBeenCalledWith('1', accessKey, { timeoutMs: 9000 });
      expect(sri.send).not.toHaveBeenCalled();
      expect(stored).toMatchObject({
        status: 'PROCESSING',
        externalState: 'SIGNED',
        leaseToken: null,
        leaseUntil: null,
      });
      expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('does not start an SRI call with less than 4 s left', async () => {
      expect(await run(row, Date.now() + 3999)).toBeUndefined();
      expect(sri.authorize).not.toHaveBeenCalled();
      expect(stored).toMatchObject({ status: 'PROCESSING', leaseToken: null });
    });

    it('fits signing, authorization, sending and one poll into a 15 s inline budget', async () => {
      stored = { ...unsigned };
      const until = Date.now() + 15000;
      const calls: { call: string; remaining: number; timeoutMs: number }[] = [];
      // Every SRI call takes 2 s and reading the signed file 1 s.
      const slow =
        (call: string, answer: unknown) =>
        async (...args: any[]) => {
          calls.push({ call, remaining: until - Date.now(), timeoutMs: args[2].timeoutMs });
          jest.setSystemTime(Date.now() + 2000);
          return answer;
        };
      sri.authorize.mockImplementation(slow('authorize', unknown));
      sri.send.mockImplementation(slow('send', received));
      const get = storage.get;
      (storage as any).get = async (key: string) => {
        jest.setSystemTime(Date.now() + 1000);
        return get(key);
      };

      expect(await run(unsigned, until)).toBeUndefined();

      expect(calls).toEqual([
        { call: 'authorize', remaining: 15000, timeoutMs: 14000 },
        { call: 'send', remaining: 12000, timeoutMs: 11000 },
        { call: 'authorize', remaining: 7000, timeoutMs: 6000 },
      ]);
      for (const { remaining, timeoutMs } of calls) {
        expect(timeoutMs).toBeLessThanOrEqual(Math.min(15000, remaining - 1000));
      }
      expect(sri.send).toHaveBeenCalledWith(
        '1',
        decrypt(get(stored.signedXmlStorageKey)),
        expect.anything(),
      );
      expect(stored).toMatchObject({
        status: 'PROCESSING',
        externalState: 'RECEIVED',
        leaseToken: null,
        leaseUntil: null,
      });
      expect(events.map((e) => e.type)).toEqual(['SIGNED', 'RECEIVED']);
    });

    it('does not apply an SRI answer once the lease was lost', async () => {
      stored.leaseToken = 'another-worker';
      sri.authorize.mockResolvedValue(authorized);
      await run();
      expect(stored).toMatchObject({ status: 'PROCESSING', externalState: 'SIGNED' });
      expect(sessions).toEqual([]);
      expect(events).toEqual([]);
    });

    it('keeps a signed row PROCESSING on a transient SRI error after 24 hours', async () => {
      const old = { ...row, requestedAt: new Date(Date.now() - 2 * 86400000) };
      stored = { ...old };
      sri.authorize.mockRejectedValue(new SriError('transient', 'SRI_TIMEOUT'));

      await worker.process(old as any);

      expect(stored).toMatchObject({
        status: 'PROCESSING',
        externalState: 'SIGNED',
        signedXmlStorageKey: row.signedXmlStorageKey,
        accessKey,
        sequential: '000000500',
        finishedAt: null,
        leaseToken: null,
        attempts: 3,
      });
      expect(stored.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      expect(JSON.parse(crypto.decrypt(tenant, stored.lastErrorEncrypted))).toEqual({
        code: 'SRI_TIMEOUT',
      });
      expect(orders).toEqual([]);
      expect(sessions).toEqual([]);
      expect(events).toEqual([
        expect.objectContaining({ type: 'RETRY_SCHEDULED', detail: { code: 'SRI_TIMEOUT' } }),
      ]);
    });
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

  it.each([false, true])('claims the due rows of each pass (reconcile: %s)', async (reconcile) => {
    await worker.claim(reconcile);
    const sql: string = tx.$queryRaw.mock.calls[0][0].sql;
    expect(sql).toContain(
      reconcile
        ? `("status" = 'PROCESSING' OR ("status" = 'AUTHORIZED' AND ("xmlStorageKey" IS NULL OR "rideStorageKey" IS NULL OR ("emailedAt" IS NULL AND "emailAttempts" < 5))))`
        : `"status" IN ('REQUESTED','PROCESSING')`,
    );
  });

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
      data: expect.objectContaining({ type: 'FAILED', issuerId: 'issuer' }),
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

  it('never records a failure on an AUTHORIZED row: it only frees the lease and backs off', async () => {
    const row = leased({ status: 'AUTHORIZED', signedXmlStorageKey: 'k', attempts: 1 });
    tx.invoiceRequest.findFirst.mockResolvedValue(row);
    emitter.advance.mockRejectedValue(new Error('socket hang up'));

    await worker.process(row as any);

    const { data } = tx.invoiceRequest.updateMany.mock.calls[0][0];
    expect(data).toEqual({
      attempts: { increment: 1 },
      nextAttemptAt: expect.any(Date),
      leaseToken: null,
      leaseUntil: null,
    });
    expect(data.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(tx.invoiceRequestEvent.create).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
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
