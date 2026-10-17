import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { InvoiceArtifactsService } from './invoice-artifacts.service';

describe('leased durable invoice artifacts', () => {
  const crypto = new ClinicalCryptoService(
    new ConfigService({
      CLINICAL_ENCRYPTION_KEYS: 'test:' + Buffer.alloc(32, 7).toString('base64'),
    }),
  );
  const bytes = Buffer.from('<fiscal/>');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let row: any;
  let prisma: any;
  let storage: any;
  let client: any;
  let service: InvoiceArtifactsService;
  beforeEach(() => {
    row = {
      id: 'request',
      tenantId: 'clinic',
      connectionId: 'connection',
      status: 'AUTHORIZED',
      externalDocumentId: 'doc',
      leaseToken: 'lease',
      leaseUntil: new Date(Date.now() + 120000),
      xmlStorageKey: null,
      rideStorageKey: 'valid-ride',
    };
    prisma = {
      invoiceRequest: {
        findFirst: jest.fn(async () => row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      invoiceRequestEvent: { create: jest.fn() },
      auditLog: { create: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(prisma)),
    };
    storage = {
      put: jest.fn(),
      remove: jest.fn(),
      get: jest.fn().mockResolvedValue(crypto.encryptBuffer('clinic', bytes)),
    };
    client = { getArtifact: jest.fn().mockResolvedValue({ bytes, sha256 }) };
    service = new InvoiceArtifactsService(prisma, crypto, storage);
  });
  it('does not fetch or store artifacts after losing its lease', async () => {
    prisma.invoiceRequest.findFirst.mockResolvedValue(null);
    await service.collect(row, client);
    expect(client.getArtifact).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });
  it('does not write files when the lease expires during download', async () => {
    client.getArtifact.mockImplementation(async () => {
      prisma.invoiceRequest.findFirst.mockResolvedValue(null);
      return { bytes, sha256 };
    });
    await service.collect(row, client);
    expect(storage.put).not.toHaveBeenCalled();
  });
  it('stores encrypted bytes and uses the current lease for the artifact CAS', async () => {
    await service.collect(row, client);
    expect(storage.put.mock.calls[0][1]).not.toEqual(bytes);
    expect(prisma.invoiceRequest.updateMany.mock.calls[0][0].where).toMatchObject({
      leaseToken: 'lease',
      leaseUntil: { gt: expect.any(Date) },
      xmlStorageKey: null,
    });
  });
  it('removes only the losing candidate when another worker stored a valid file', async () => {
    prisma.invoiceRequest.updateMany.mockResolvedValue({ count: 0 });
    await service.collect(row, client);
    expect(storage.remove).toHaveBeenCalledWith(storage.put.mock.calls[0][0]);
    expect(storage.remove).not.toHaveBeenCalledWith('valid-ride');
  });
  it('keeps authorization while refusing corrupt provider bytes', async () => {
    client.getArtifact.mockResolvedValue({ bytes, sha256: '0'.repeat(64) });
    await service.collect(row, client);
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.invoiceRequest.updateMany).not.toHaveBeenCalled();
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
