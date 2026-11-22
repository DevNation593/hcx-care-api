import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-options';
import { ListInvoiceRequestsQuery } from './dto/invoice-requests.dto';
import { InvoiceRequestsService } from './invoice-requests.service';

describe('issued invoices listing', () => {
  let prisma: any;
  let crypto: any;
  let service: InvoiceRequestsService;
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'request',
    tenantId: 'clinic',
    orderId: 'order',
    billingProfileId: 'profile',
    status: 'AUTHORIZED',
    number: '001-001-000000123',
    sequential: '000000123',
    snapshotEncrypted: 'encrypted-snapshot',
    lastErrorEncrypted: null,
    xmlStorageKey: 'xml',
    rideStorageKey: 'ride',
    order: { number: 7, branchId: 'branch' },
    ...overrides,
  });
  const query = (overrides: Partial<ListInvoiceRequestsQuery> = {}) =>
    Object.assign(new ListInvoiceRequestsQuery(), overrides);
  const whereOf = () => prisma.invoiceRequest.findMany.mock.calls[0][0].where;

  beforeEach(() => {
    prisma = {
      invoiceRequest: {
        findMany: jest.fn().mockResolvedValue([row()]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    crypto = {
      decrypt: jest
        .fn()
        .mockReturnValue(
          JSON.stringify({ issueDate: '2026-11-20', customer: { name: 'Cliente Fiscal' } }),
        ),
    };
    service = new InvoiceRequestsService(prisma, crypto);
  });

  it('adds the issue date and the customer name from the frozen snapshot', async () => {
    const page = await service.list('clinic', query());
    expect(crypto.decrypt).toHaveBeenCalledWith('clinic', 'encrypted-snapshot');
    expect(page.items[0]).toMatchObject({
      number: '001-001-000000123',
      issueDate: '2026-11-20',
      customerName: 'Cliente Fiscal',
    });
    expect(page.items[0]).not.toHaveProperty('snapshotEncrypted');
  });

  it('keeps the row, without date or name, when its snapshot cannot be read', async () => {
    crypto.decrypt.mockImplementation(() => {
      throw new Error('unknown key');
    });
    const page = await service.list('clinic', query());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ issueDate: null, customerName: null });
  });

  it('always scopes by tenant and adds no number filter without a search', async () => {
    await service.list('clinic', query());
    expect(whereOf().tenantId).toBe('clinic');
    expect(whereOf()).not.toHaveProperty('OR');
    expect(whereOf()).not.toHaveProperty('number');
  });

  it('finds the sequence alone, with or without leading zeros, and any part of the number', async () => {
    await service.list('clinic', query({ q: '123' }));
    expect(whereOf()).toMatchObject({
      tenantId: 'clinic',
      OR: [{ sequential: '000000123' }, { number: { contains: '123' } }],
    });
  });

  it('searches the whole or partial number with its hyphens as typed', async () => {
    await service.list('clinic', query({ q: '001-001-000000123' }));
    expect(whereOf()).toMatchObject({
      tenantId: 'clinic',
      number: { contains: '001-001-000000123' },
    });
    expect(whereOf()).not.toHaveProperty('OR');
  });

  describe('search parameter', () => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const read = (q: unknown) =>
      pipe.transform({ q }, { type: 'query', metatype: ListInvoiceRequestsQuery });

    it('accepts digits and hyphens, trimmed', async () => {
      await expect(read('  001-001-000000123 ')).resolves.toMatchObject({
        q: '001-001-000000123',
      });
      await expect(read('123')).resolves.toMatchObject({ q: '123' });
    });

    it('treats a blank search as no search', async () => {
      expect((await read('   ')).q).toBeUndefined();
    });

    it.each(["1' OR '1'='1", '12%', '12_3', 'abc', '1'.repeat(18), '1 2'])(
      'rejects %j',
      async (q) => {
        await expect(read(q)).rejects.toMatchObject({ status: 400 });
      },
    );
  });
});
