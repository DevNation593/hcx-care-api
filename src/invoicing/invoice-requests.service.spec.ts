import { Prisma } from '@prisma/client';
import { loadOrderBillingFacts } from '../orders/eligibility-facts';
import { InvoiceRequestsService } from './invoice-requests.service';

jest.mock('../orders/eligibility-facts', () => ({ loadOrderBillingFacts: jest.fn() }));

describe('invoice acceptance receipts and protected fiscal explanations', () => {
  const fiscalError = JSON.stringify({
    code: 'SRI_REJECTED',
    attempts: [{ messages: [{ message: 'PRIVATE_SRI_EXPLANATION' }] }],
  });
  const rejected = {
    id: 'request',
    tenantId: 'clinic',
    orderId: 'order',
    status: 'REJECTED',
    lastErrorEncrypted: 'encrypted-sri',
  };
  let tx: any;
  let prisma: any;
  let crypto: any;
  let service: InvoiceRequestsService;
  let issuer: any;
  beforeEach(() => {
    issuer = {
      id: 'issuer',
      tenantId: 'clinic',
      ruc: '1790012345001',
      legalName: 'Clínica Ejemplo S.A.',
      tradeName: 'Clínica Ejemplo',
      headOfficeAddress: 'Av. Amazonas N1-23, Quito',
      accountingRequired: true,
      specialTaxpayerCode: '123',
      withholdingAgentCode: null,
      rimpeRegime: 'EMPRENDEDOR',
      environment: '2',
      active: true,
      certificateEncrypted: 'encrypted-p12',
      certificatePasswordEncrypted: 'encrypted-password',
      revision: 3,
    };
    tx = {
      invoiceRequest: {
        findUnique: jest.fn().mockResolvedValue(rejected),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockResolvedValue({ ...rejected, status: 'REQUESTED', lastErrorEncrypted: null }),
      },
      order: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'order',
          number: 1,
          branchId: 'branch',
          status: 'PAID',
          total: new Prisma.Decimal(40),
          billingProfile: {
            id: 'profile',
            idType: '06',
            idNumber: 'BUYER',
            legalName: 'Fiscal buyer',
          },
          items: [
            {
              id: 'item',
              kind: 'FREE',
              description: 'Service',
              quantity: new Prisma.Decimal(1),
              unitPrice: new Prisma.Decimal(40),
              discount: new Prisma.Decimal(0),
              taxRatePercent: new Prisma.Decimal(0),
            },
          ],
          payments: [{ method: 'CASH', amount: new Prisma.Decimal(40) }],
        }),
        update: jest.fn(),
      },
      invoicingIssuer: { findUnique: jest.fn().mockResolvedValue(issuer) },
      branchEmissionPoint: {
        findFirst: jest.fn().mockResolvedValue({
          issuerId: 'issuer',
          establishmentCode: '001',
          emissionPointCode: '002',
          establishmentAddress: 'Av. 6 de Diciembre, Quito',
        }),
      },
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({ monthlyElectronicInvoicesLimit: 50 }),
      },
      treatmentSession: { updateMany: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    prisma = {
      invoiceRequest: {
        findUnique: jest.fn().mockResolvedValue(rejected),
        findFirst: jest.fn().mockResolvedValue(rejected),
      },
      applyRlsContext: jest.fn(),
      $transaction: jest.fn(async (fn) => fn(tx)),
    };
    crypto = {
      enabled: true,
      encrypt: jest.fn().mockReturnValue('encrypted-intent'),
      decrypt: jest.fn().mockReturnValue(fiscalError),
    };
    service = new InvoiceRequestsService(prisma, crypto);
    jest.mocked(loadOrderBillingFacts).mockResolvedValue({
      sessions: [],
      itemCount: 1,
      total: new Prisma.Decimal(40),
      paidTotal: new Prisma.Decimal(40),
      profile: { isActive: true, idType: '06' },
      invoicingConfigured: true,
    });
  });
  it('does not decrypt or expose SRI explanations on an initial same-key replay', async () => {
    const receipt = await service.create('clinic', 'creator', 'order', 'same-key');
    expect(receipt.status).toBe('REJECTED');
    expect(receipt.lastError).toBeNull();
    expect(crypto.decrypt).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SRI_EXPLANATION');
  });
  it('does not decrypt or expose SRI explanations on unique-collision recovery', async () => {
    prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    const receipt = await service.create('clinic', 'creator', 'order', 'same-key');
    expect(receipt.lastError).toBeNull();
    expect(crypto.decrypt).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SRI_EXPLANATION');
  });
  it('returns an initial receipt without decrypting stored data', async () => {
    tx.invoiceRequest.findUnique.mockResolvedValue(null);
    const receipt = await service.create('clinic', 'creator', 'order', 'new-key');
    expect(receipt.status).toBe('REQUESTED');
    expect(receipt.lastError).toBeNull();
    expect(crypto.decrypt).not.toHaveBeenCalled();
  });
  it('sends a product line with the product code and its product id as local id', async () => {
    tx.invoiceRequest.findUnique.mockResolvedValue(null);
    tx.order.findFirst.mockResolvedValue({
      ...(await tx.order.findFirst()),
      items: [
        {
          id: 'item',
          kind: 'PRODUCT',
          productId: 'product-1',
          product: { code: 'SOLAR-50' },
          description: 'Protector solar',
          quantity: new Prisma.Decimal(2),
          unitPrice: new Prisma.Decimal(20),
          discount: new Prisma.Decimal(0),
          taxRatePercent: new Prisma.Decimal(0),
        },
      ],
    });

    await service.create('clinic', 'creator', 'order', 'new-key');

    const include = tx.order.findFirst.mock.calls.at(-1)[0].include;
    expect(include.items.include.product).toEqual({ select: { code: true } });
    const snapshot = JSON.parse(crypto.encrypt.mock.calls[0][1]);
    expect(snapshot.lines).toEqual([
      expect.objectContaining({
        localId: 'product-1',
        code: 'SOLAR-50',
        name: 'Protector solar',
        quantity: '2.000000',
      }),
    ]);
  });
  describe('new requests', () => {
    beforeEach(() => tx.invoiceRequest.findUnique.mockResolvedValue(null));
    const frozen = () => JSON.parse(crypto.encrypt.mock.calls[0][1]);

    it('freezes the issuer, establishment address and environment in the snapshot', async () => {
      await service.create('clinic', 'creator', 'order', 'new-key');

      expect(tx.invoicingIssuer.findUnique).toHaveBeenCalledWith({ where: { tenantId: 'clinic' } });
      expect(tx.branchEmissionPoint.findFirst).toHaveBeenCalledWith({
        where: { branchId: 'branch', issuerId: 'issuer' },
      });
      const snapshot = frozen();
      expect(snapshot).toMatchObject({
        issuerId: 'issuer',
        issuer: {
          ruc: '1790012345001',
          legalName: 'Clínica Ejemplo S.A.',
          tradeName: 'Clínica Ejemplo',
          headOfficeAddress: 'Av. Amazonas N1-23, Quito',
          accountingRequired: true,
          specialTaxpayerCode: '123',
          withholdingAgentCode: null,
          rimpeRegime: 'EMPRENDEDOR',
        },
        environment: '2',
        establishmentCode: '001',
        emissionPointCode: '002',
        establishmentAddress: 'Av. 6 de Diciembre, Quito',
      });
      expect(snapshot.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.keys(snapshot.issuer).sort()).toEqual([
        'accountingRequired',
        'headOfficeAddress',
        'legalName',
        'rimpeRegime',
        'ruc',
        'specialTaxpayerCode',
        'tradeName',
        'withholdingAgentCode',
      ]);
      expect(snapshot).not.toHaveProperty('taxpayerId');
      expect(snapshot).not.toHaveProperty('replacesDocumentId');
      const { data } = tx.invoiceRequest.create.mock.calls[0][0];
      expect(data).toMatchObject({
        issuerId: 'issuer',
        events: { create: { issuerId: 'issuer', type: 'REQUESTED' } },
      });
      expect(data).not.toHaveProperty('connectionId');
      expect(data).not.toHaveProperty('providerIdempotencyKey');
    });

    it.each([
      ['no issuer', () => tx.invoicingIssuer.findUnique.mockResolvedValue(null)],
      ['an inactive issuer', () => (issuer.active = false)],
      ['an issuer without certificate', () => (issuer.certificateEncrypted = null)],
      ['no point for the branch', () => tx.branchEmissionPoint.findFirst.mockResolvedValue(null)],
    ])(
      'requires an active issuer with a certificate and a point for the branch (%s)',
      async (_, change) => {
        change();
        await expect(service.create('clinic', 'creator', 'order', 'new-key')).rejects.toMatchObject(
          {
            status: 422,
            response: { code: 'INVOICING_NOT_CONFIGURED' },
          },
        );
        expect(tx.invoiceRequest.create).not.toHaveBeenCalled();
        expect(tx.order.update).not.toHaveBeenCalled();
      },
    );

    const finalConsumerOrder = async (total: string) => {
      const order = await tx.order.findFirst();
      tx.order.findFirst.mockResolvedValue({
        ...order,
        total: new Prisma.Decimal(total),
        billingProfile: {
          id: 'profile',
          idType: '07',
          idNumber: '9999999999999',
          legalName: 'CONSUMIDOR FINAL',
        },
        items: [{ ...order.items[0], unitPrice: new Prisma.Decimal(total) }],
        payments: [{ method: 'CASH', amount: new Prisma.Decimal(total) }],
      });
    };

    it('refuses a final consumer invoice above USD 50 before marking the order invoiced', async () => {
      await finalConsumerOrder('50.01');
      await expect(service.create('clinic', 'creator', 'order', 'new-key')).rejects.toMatchObject({
        status: 422,
        response: { code: 'FINAL_CONSUMER_LIMIT' },
      });
      expect(tx.order.update).not.toHaveBeenCalled();
      expect(tx.invoiceRequest.create).not.toHaveBeenCalled();
    });

    it('accepts a final consumer invoice of exactly USD 50', async () => {
      await finalConsumerOrder('50.00');
      await service.create('clinic', 'creator', 'order', 'new-key');
      expect(tx.order.update).toHaveBeenCalled();
      expect(frozen().customer).toMatchObject({ idType: '07', idNumber: '9999999999999' });
    });
  });
  it('preserves decrypted SRI explanations for protected detail queries', async () => {
    const detail = await service.get('clinic', 'request');
    expect(detail.lastError.attempts[0].messages[0].message).toBe('PRIVATE_SRI_EXPLANATION');
    expect(crypto.decrypt).toHaveBeenCalledWith('clinic', 'encrypted-sri');
  });
});
