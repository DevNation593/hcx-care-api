import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.service';

describe('BillingService (read-only invoice history)', () => {
  const prisma = {
    invoice: { findMany: jest.fn(), findFirst: jest.fn() },
  };
  const patientSelect = { select: { id: true, firstName: true, lastName: true } };
  let service: BillingService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new BillingService(prisma as unknown as PrismaService);
  });

  it('exposes only the read methods', () => {
    expect((service as unknown as Record<string, unknown>).createInvoice).toBeUndefined();
  });

  it('lists the clinic invoices with their patient', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ id: 'invoice-1', patient: null }]);
    await expect(service.listInvoices('tenant-1')).resolves.toEqual([
      { id: 'invoice-1', patient: null },
    ]);

    const query = prisma.invoice.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ tenantId: 'tenant-1' });
    expect(query.include.patient).toEqual(patientSelect);
  });

  it('filters by patient inside the clinic', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    await service.listInvoices('tenant-1', { patientId: 'patient-1' });
    expect(prisma.invoice.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant-1',
      patientId: 'patient-1',
    });
  });

  it('ignores a blank patient filter', async () => {
    prisma.invoice.findMany.mockResolvedValue([]);
    await service.listInvoices('tenant-1', { patientId: '  ' });
    expect(prisma.invoice.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1' });
  });

  it('returns one invoice with its patient', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'invoice-1' });
    await service.getInvoice('tenant-1', 'invoice-1');
    expect(prisma.invoice.findFirst.mock.calls[0][0].include.patient).toEqual(patientSelect);
  });

  it('answers 404 for an invoice outside the clinic', async () => {
    prisma.invoice.findFirst.mockResolvedValue(null);
    await expect(service.getInvoice('tenant-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
