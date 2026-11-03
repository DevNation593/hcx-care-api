import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { InvoiceDeliveryService } from './invoice-delivery.service';
import { FiscalSnapshot } from './invoice-snapshot';
import { sampleDocument } from './sri/testing/sample-document';

const tenant = 'clinic';
const crypto = new ClinicalCryptoService(
  new ConfigService({ CLINICAL_ENCRYPTION_KEYS: 'test:' + Buffer.alloc(32, 7).toString('base64') }),
);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('InvoiceDeliveryService', () => {
  const doc = sampleDocument();
  const xml = Buffer.from('<autorizacion/>');
  const pdf = Buffer.from('%PDF-1.7 ride');
  const snapshot = (email: string | null): FiscalSnapshot => ({
    customer: { ...doc.customer, email },
    issuerId: 'issuer',
    issuer: doc.issuer,
    environment: '1',
    establishmentCode: '001',
    emissionPointCode: '002',
    establishmentAddress: doc.establishmentAddress,
    issueDate: '2026-10-07',
    lines: doc.lines,
    payments: doc.payments,
  });
  let row: any;
  let files: Map<string, Buffer>;
  let prisma: any;
  let mail: { send: jest.Mock };
  let service: InvoiceDeliveryService;
  const events = () => prisma.invoiceRequestEvent.create.mock.calls.map(([a]: any) => a.data);

  beforeEach(() => {
    files = new Map([
      ['xml', crypto.encryptBuffer(tenant, xml)],
      ['ride', crypto.encryptBuffer(tenant, pdf)],
    ]);
    row = {
      id: 'request',
      tenantId: tenant,
      issuerId: 'issuer',
      status: 'AUTHORIZED',
      number: '001-002-000000123',
      authorizedAt: new Date('2026-10-08T03:30:00Z'),
      snapshotEncrypted: crypto.encrypt(tenant, JSON.stringify(snapshot('juan@example.com'))),
      xmlStorageKey: 'xml',
      xmlSha256: sha256(xml),
      rideStorageKey: 'ride',
      rideSha256: sha256(pdf),
      emailedAt: null,
      emailAttempts: 0,
      nextAttemptAt: new Date(),
      leaseToken: 'lease',
      leaseUntil: new Date(Date.now() + 120000),
    };
    prisma = {
      invoiceRequest: {
        findFirst: jest.fn(async () => ({ ...row })),
        updateMany: jest.fn(async ({ data }: any) => {
          for (const [field, value] of Object.entries<any>(data))
            row[field] =
              value && typeof value === 'object' && 'increment' in value
                ? row[field] + value.increment
                : value;
          return { count: 1 };
        }),
      },
      invoiceRequestEvent: { create: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(prisma)),
    };
    mail = { send: jest.fn().mockResolvedValue(true) };
    const storage = { get: jest.fn(async (key: string) => files.get(key)) };
    service = new InvoiceDeliveryService(prisma, crypto, storage as any, mail as any);
  });

  afterEach(() => jest.useRealTimers());

  it('emails both files once to the customer', async () => {
    await service.deliver(row);

    expect(mail.send).toHaveBeenCalledTimes(1);
    const [to, content] = mail.send.mock.calls[0];
    expect(to).toBe('juan@example.com');
    expect(content.subject).toBe(`Factura 001-002-000000123 de ${doc.issuer.tradeName}`);
    expect(content.text).toContain(`Hola ${doc.customer.name},`);
    expect(content.attachments).toEqual([
      {
        filename: 'factura-001-002-000000123.xml',
        content: xml,
        contentType: 'application/xml',
      },
      {
        filename: 'factura-001-002-000000123.pdf',
        content: pdf,
        contentType: 'application/pdf',
      },
    ]);
    expect(row.emailedAt).toBeInstanceOf(Date);
    expect(events()).toEqual([expect.objectContaining({ type: 'EMAILED', source: 'DISPATCHER' })]);
    expect(JSON.stringify(events())).not.toContain('juan@example.com');

    await service.deliver(row);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('skips customers without email (consumidor final) and marks them so the reconciler stops claiming them', async () => {
    row.snapshotEncrypted = crypto.encrypt(tenant, JSON.stringify(snapshot(null)));

    await service.deliver(row);

    expect(mail.send).not.toHaveBeenCalled();
    expect(row.emailAttempts).toBe(5);
    expect(row.emailedAt).toBeNull();
    expect(events()).toEqual([expect.objectContaining({ type: 'EMAIL_SKIPPED' })]);
  });

  it('treats a blank address as no address', async () => {
    row.snapshotEncrypted = crypto.encrypt(tenant, JSON.stringify(snapshot('   ')));
    await service.deliver(row);
    expect(mail.send).not.toHaveBeenCalled();
    expect(row.emailAttempts).toBe(5);
  });

  it('counts failed sends, schedules the retry and stops after 5 attempts', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    mail.send.mockResolvedValue(false);

    for (let attempt = 1; attempt <= 5; attempt++) {
      await service.deliver(row);
      expect(row.emailAttempts).toBe(attempt);
      expect(row.nextAttemptAt.getTime()).toBe(Date.now() + 30000 * 2 ** (attempt - 1));
    }
    expect(events().map((e: any) => e.type)).toEqual(Array(5).fill('EMAIL_FAILED'));
    expect(events()[0].detail).toEqual({ attempt: 1 });

    await service.deliver(row);
    expect(mail.send).toHaveBeenCalledTimes(5);
    expect(row.emailedAt).toBeNull();
  });

  it('counts an unreadable or altered file as a failed attempt without sending', async () => {
    row.rideSha256 = '0'.repeat(64);
    await service.deliver(row);
    files.delete('xml');
    await service.deliver(row);
    expect(mail.send).not.toHaveBeenCalled();
    expect(row.emailAttempts).toBe(2);
  });

  it.each([
    ['already emailed', () => (row.emailedAt = new Date())],
    ['out of attempts', () => (row.emailAttempts = 5)],
    ['missing the XML', () => (row.xmlStorageKey = null)],
    ['missing the RIDE', () => (row.rideStorageKey = null)],
    ['not authorized', () => (row.status = 'PROCESSING')],
  ])('does nothing when %s', async (_label, change) => {
    change();
    prisma.invoiceRequest.findFirst.mockImplementation(async ({ where }: any) =>
      where.status === row.status ? { ...row } : null,
    );
    await service.deliver(row);
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.invoiceRequest.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing without the lease', async () => {
    prisma.invoiceRequest.findFirst.mockResolvedValue(null);
    await service.deliver(row);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('records the outcome only while it still holds the lease', async () => {
    prisma.invoiceRequest.updateMany.mockResolvedValue({ count: 0 });
    await service.deliver(row);
    expect(prisma.invoiceRequest.updateMany.mock.calls[0][0].where).toMatchObject({
      leaseToken: 'lease',
      leaseUntil: { gt: expect.any(Date) },
      emailedAt: null,
    });
    expect(prisma.invoiceRequestEvent.create).not.toHaveBeenCalled();
  });
});
