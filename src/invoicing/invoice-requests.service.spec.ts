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
  beforeEach(() => {
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
      invoicingConnection: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'connection', taxpayerId: 'issuer', environment: '1' }),
      },
      branchEmissionPoint: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ establishmentCode: '001', emissionPointCode: '002' }),
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
  it('preserves decrypted SRI explanations for protected detail queries', async () => {
    const detail = await service.get('clinic', 'request');
    expect(detail.lastError.attempts[0].messages[0].message).toBe('PRIVATE_SRI_EXPLANATION');
    expect(crypto.decrypt).toHaveBeenCalledWith('clinic', 'encrypted-sri');
  });
});
