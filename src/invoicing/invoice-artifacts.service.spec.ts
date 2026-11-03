import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { InvoiceArtifactsService } from './invoice-artifacts.service';
import { FiscalSnapshot } from './invoice-snapshot';
import * as rideModule from './sri/ride';
import { sampleDocument } from './sri/testing/sample-document';

const tenant = 'clinic';
const crypto = new ClinicalCryptoService(
  new ConfigService({ CLINICAL_ENCRYPTION_KEYS: 'test:' + Buffer.alloc(32, 7).toString('base64') }),
);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const decrypt = (bytes: Buffer) => crypto.decryptBuffer(tenant, bytes);

describe('leased durable invoice artifacts', () => {
  const doc = sampleDocument();
  const signedXml = Buffer.from('<factura id="comprobante"><infoTributaria/></factura>');
  const snapshot: FiscalSnapshot = {
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
  const authorizationNumber = '0710202601179001234500110010020000001231234567816';
  const authorizedAt = new Date('2026-10-08T03:30:00Z');
  let row: any;
  let stored: Map<string, Buffer>;
  let prisma: any;
  let storage: any;
  let service: InvoiceArtifactsService;
  const events = () => prisma.invoiceRequestEvent.create.mock.calls.map(([a]: any) => a.data);

  beforeEach(() => {
    stored = new Map([['signed', crypto.encryptBuffer(tenant, signedXml)]]);
    row = {
      id: 'request',
      tenantId: tenant,
      issuerId: 'issuer',
      status: 'AUTHORIZED',
      sequential: '000000123',
      accessKey: authorizationNumber,
      authorizationNumber,
      authorizedAt,
      snapshotEncrypted: crypto.encrypt(tenant, JSON.stringify(snapshot)),
      signedXmlStorageKey: 'signed',
      signedXmlSha256: sha256(signedXml),
      xmlStorageKey: null,
      xmlSha256: null,
      rideStorageKey: null,
      rideSha256: null,
      leaseToken: 'lease',
      leaseUntil: new Date(Date.now() + 120000),
    };
    prisma = {
      invoiceRequest: {
        findFirst: jest.fn(async () => row),
        updateMany: jest.fn(async ({ data }: any) => {
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      invoiceRequestEvent: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(prisma)),
    };
    storage = {
      put: jest.fn(async (key: string, data: Buffer) => void stored.set(key, data)),
      get: jest.fn(async (key: string) => stored.get(key)),
      remove: jest.fn(async (key: string) => void stored.delete(key)),
    };
    service = new InvoiceArtifactsService(prisma, crypto, storage);
  });

  afterEach(() => jest.restoreAllMocks());

  it('stores the authorized XML and the RIDE encrypted with their hashes', async () => {
    await service.collect(row);

    const xml = decrypt(stored.get(row.xmlStorageKey)!);
    const ride = decrypt(stored.get(row.rideStorageKey)!);
    expect(xml.toString('utf8')).toContain('<estado>AUTORIZADO</estado>');
    expect(xml.toString('utf8')).toContain(`<numeroAutorizacion>${authorizationNumber}`);
    expect(xml.toString('utf8')).toContain('<ambiente>PRUEBAS</ambiente>');
    expect(xml.toString('utf8')).toContain(`<![CDATA[${signedXml.toString('utf8')}]]>`);
    expect(ride.subarray(0, 5).toString()).toBe('%PDF-');
    expect(row.xmlSha256).toBe(sha256(xml));
    expect(row.rideSha256).toBe(sha256(ride));
    expect(row.xmlStorageKey).toMatch(/^invoices\/clinic\/request\/xml-[0-9a-f-]{36}$/);
    expect(row.rideStorageKey).toMatch(/^invoices\/clinic\/request\/ride-[0-9a-f-]{36}$/);
    expect(prisma.invoiceRequest.updateMany.mock.calls[0][0].where).toMatchObject({
      status: 'AUTHORIZED',
      leaseToken: 'lease',
      leaseUntil: { gt: expect.any(Date) },
      xmlStorageKey: null,
    });
    expect(events()).toEqual([
      expect.objectContaining({
        type: 'ARTIFACT_STORED',
        detail: { kind: 'xml', sha256: row.xmlSha256 },
      }),
      expect.objectContaining({
        type: 'ARTIFACT_STORED',
        detail: { kind: 'ride', sha256: row.rideSha256 },
      }),
    ]);
  });

  it('labels production authorizations in the XML', async () => {
    row.snapshotEncrypted = crypto.encrypt(
      tenant,
      JSON.stringify({ ...snapshot, environment: '2' }),
    );
    await service.collect(row);
    expect(decrypt(stored.get(row.xmlStorageKey)!).toString('utf8')).toContain(
      '<ambiente>PRODUCCIÓN</ambiente>',
    );
  });

  it('only stores what is missing', async () => {
    row.rideStorageKey = 'valid-ride';
    await service.collect(row);
    expect(row.xmlStorageKey).toBeTruthy();
    expect(row.rideStorageKey).toBe('valid-ride');
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('keeps the authorization when the RIDE fails to render and retries later', async () => {
    const render = jest.spyOn(rideModule, 'renderRide').mockRejectedValueOnce(new Error('boom'));

    await expect(service.collect(row)).resolves.toBeUndefined();
    expect(row.xmlStorageKey).toBeTruthy();
    expect(row.rideStorageKey).toBeNull();
    expect(row.status).toBe('AUTHORIZED');
    expect(storage.put).toHaveBeenCalledTimes(1);

    await service.collect(row);
    expect(render).toHaveBeenCalledTimes(2);
    expect(row.rideStorageKey).toBeTruthy();
    expect(storage.put).toHaveBeenCalledTimes(2);
  });

  it('stores nothing when the signed XML was altered or cannot be read', async () => {
    row.signedXmlSha256 = '0'.repeat(64);
    await service.collect(row);
    storage.get.mockRejectedValue(new Error('storage down'));
    row.signedXmlSha256 = sha256(signedXml);
    await service.collect(row);
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.invoiceRequest.updateMany).not.toHaveBeenCalled();
  });

  it('does not build or store anything without the lease', async () => {
    prisma.invoiceRequest.findFirst.mockResolvedValue(null);
    await service.collect(row);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('does not write files when the lease expires while rendering', async () => {
    jest.spyOn(rideModule, 'renderRide').mockImplementation(async () => {
      prisma.invoiceRequest.findFirst.mockResolvedValue(null);
      return Buffer.from('%PDF-');
    });
    row.xmlStorageKey = 'valid-xml';
    await service.collect(row);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('removes only the losing candidate when another worker stored a valid file', async () => {
    row.rideStorageKey = 'valid-ride';
    prisma.invoiceRequest.updateMany.mockResolvedValue({ count: 0 });
    await service.collect(row);
    expect(storage.remove).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
    expect(storage.remove).not.toHaveBeenCalledWith('valid-ride');
    expect(prisma.invoiceRequestEvent.create).not.toHaveBeenCalled();
  });

  it('leaves rows that are not authorized alone', async () => {
    row.status = 'PROCESSING';
    await service.collect(row);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('refuses corrupt storage bytes and does not audit a successful download', async () => {
    row.xmlStorageKey = 'xml';
    row.xmlSha256 = '0'.repeat(64);
    await expect(service.read('clinic', 'actor', row.id, 'xml')).rejects.toMatchObject({
      response: { code: 'INVOICE_ARTIFACT_INTEGRITY' },
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
