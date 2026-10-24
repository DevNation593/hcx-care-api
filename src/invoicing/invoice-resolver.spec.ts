import { ConfigService } from '@nestjs/config';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { InvoiceResolver } from './invoice-resolver';

describe('fiscal resolution lease boundaries', () => {
  const crypto = new ClinicalCryptoService(
    new ConfigService({
      CLINICAL_ENCRYPTION_KEYS: 'test:' + Buffer.alloc(32, 7).toString('base64'),
    }),
  );
  const customer = {
    idType: '06',
    idNumber: 'BUYER',
    name: 'Fiscal buyer',
    email: null,
    address: null,
    phone: null,
  };
  const snapshot = {
    customer,
    taxpayerId: 'issuer',
    environment: '1',
    establishmentCode: '001',
    emissionPointCode: '002',
    issueDate: '2026-10-17',
    lines: [
      {
        localId: 'version',
        name: 'Service',
        quantity: '1.000000',
        unitPrice: '40.00',
        discount: '0.00',
        taxRatePercent: '0.00',
      },
    ],
    payments: [{ methodCode: '01', amount: '40.00' }],
  };
  let row: any;
  let db: any;
  let client: any;
  let resolver: InvoiceResolver;
  let owns: boolean;
  beforeEach(() => {
    owns = true;
    row = {
      id: 'request',
      tenantId: 'clinic',
      billingProfileId: 'profile',
      connectionId: 'connection',
      leaseToken: 'lease',
      snapshotEncrypted: crypto.encrypt('clinic', JSON.stringify(snapshot)),
    };
    db = {
      invoiceRequest: {
        findFirst: jest.fn(async () => (owns ? row : null)),
        updateMany: jest.fn(async () => ({ count: owns ? 1 : 0 })),
      },
      invoicingRef: { upsert: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(db)),
    };
    client = {
      listTaxpayers: jest.fn().mockResolvedValue([{ id: 'issuer', defaultEnvironment: '1' }]),
      listEstablishments: jest
        .fn()
        .mockResolvedValue([{ id: 'establishment', taxpayerId: 'issuer', code: '001' }]),
      listEmissionPoints: jest
        .fn()
        .mockResolvedValue([
          { id: 'point', establishmentId: 'establishment', code: '002', enabled: true },
        ]),
      findCustomer: jest.fn().mockResolvedValue({ ...customer, id: 'customer' }),
      createCustomer: jest.fn().mockResolvedValue({ ...customer, id: 'customer' }),
      listTaxRates: jest.fn().mockResolvedValue([{ taxCode: '2', rateCode: '0', rate: '0' }]),
      findProduct: jest.fn().mockResolvedValue(null),
      createProduct: jest.fn().mockImplementation(async (p) => ({ ...p, id: 'product' })),
    };
    resolver = new InvoiceResolver(db, crypto);
  });
  it('does not create customers when a lease expires during lookup', async () => {
    client.findCustomer.mockImplementation(async () => {
      owns = false;
      return null;
    });
    await expect(resolver.resolve(row, client)).rejects.toBeDefined();
    expect(client.createCustomer).not.toHaveBeenCalled();
    expect(db.invoicingRef.upsert).not.toHaveBeenCalled();
  });
  it('does not create products after losing its lease during catalog lookup', async () => {
    client.findProduct.mockImplementation(async () => {
      owns = false;
      return null;
    });
    await expect(resolver.resolve(row, client)).rejects.toBeDefined();
    expect(client.createProduct).not.toHaveBeenCalled();
  });
  it('does not persist stale references when the lease CAS fails', async () => {
    db.invoiceRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(resolver.resolve(row, client)).rejects.toBeDefined();
    expect(db.invoicingRef.upsert).not.toHaveBeenCalled();
  });
  it('resolves only the immutable fiscal customer and line fields', async () => {
    const body = await resolver.resolve(row, client);
    expect(body).toEqual({
      taxpayerId: 'issuer',
      establishmentCode: '001',
      emissionPointCode: '002',
      customerId: 'customer',
      issueDate: '2026-10-17',
      currency: 'USD',
      lines: [{ productId: 'product', quantity: '1.000000', unitPrice: '40.00', discount: '0.00' }],
      payments: snapshot.payments,
    });
    expect(db.invoicingRef.upsert).toHaveBeenCalledTimes(2);
  });
  it('keeps the hashed SKU for lines without a code', async () => {
    await resolver.resolve(row, client);
    expect(client.createProduct.mock.calls[0][0].sku).toMatch(/^HCX\.[0-9a-f]{21}$/);
  });
  describe('treatment lines', () => {
    const withCode = (line: Record<string, string>) => {
      row.snapshotEncrypted = crypto.encrypt(
        'clinic',
        JSON.stringify({ ...snapshot, lines: [{ ...snapshot.lines[0], ...line }] }),
      );
    };
    it('send the treatment code as the main code', async () => {
      withCode({ code: 'TOX-01' });
      const body = await resolver.resolve(row, client);
      expect(client.findProduct).toHaveBeenCalledWith('TOX-01');
      expect(client.createProduct).toHaveBeenCalledWith({
        sku: 'TOX-01',
        name: 'Service',
        unitPrice: '40.00',
        ivaRateCode: '0',
      });
      expect(body.lines[0].productId).toBe('product');
    });
    it('reuse the product under the code at another price', async () => {
      withCode({ code: 'TOX-01', unitPrice: '55.00' });
      client.findProduct.mockResolvedValue({
        id: 'existing',
        sku: 'TOX-01',
        name: 'Service',
        unitPrice: '40.000000',
        ivaRateCode: '0',
      });
      const body = await resolver.resolve(row, client);
      expect(client.createProduct).not.toHaveBeenCalled();
      expect(body.lines[0]).toMatchObject({ productId: 'existing', unitPrice: '55.00' });
    });
    it('fall back to the code plus a short hash once the product under the code was renamed', async () => {
      withCode({ code: 'TOX-01' });
      client.findProduct.mockImplementation(async (sku: string) =>
        sku === 'TOX-01'
          ? { id: 'old', sku, name: 'Old name', unitPrice: '40.000000', ivaRateCode: '0' }
          : null,
      );
      const body = await resolver.resolve(row, client);
      const sku = client.createProduct.mock.calls[0][0].sku;
      expect(sku).toMatch(/^TOX-01\.[0-9a-f]{4}$/);
      expect(sku.length).toBeLessThanOrEqual(25);
      expect(body.lines[0].productId).toBe('product');
    });
    it('fail when neither the code nor its fallback match', async () => {
      withCode({ code: 'TOX-01' });
      client.findProduct.mockImplementation(async (sku: string) => ({
        id: sku,
        sku,
        name: 'Old name',
        unitPrice: '40.000000',
        ivaRateCode: '0',
      }));
      await expect(resolver.resolve(row, client)).rejects.toMatchObject({
        code: 'PRODUCT_SYNC_REQUIRED',
      });
    });
  });
});
