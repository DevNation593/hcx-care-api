import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from './products.service';

const D = (value: string) => new Prisma.Decimal(value);

describe('ProductsService', () => {
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    auditLog: { create: jest.fn() },
    tenantSettings: { findUnique: jest.fn() },
    treatment: { findFirst: jest.fn() },
    branch: { findMany: jest.fn() },
    product: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    stockLot: { findMany: jest.fn(), count: jest.fn() },
  };
  const service = new ProductsService(prisma as unknown as PrismaService);

  const productRow = (extra: Record<string, unknown> = {}) => ({
    id: 'product-1',
    tenantId: 'tenant-1',
    code: 'PROT-01',
    name: 'Protector solar',
    category: null,
    barcode: null,
    price: D('25'),
    taxRatePercent: D('15'),
    tracksExpiry: true,
    minStock: 0,
    isActive: true,
    createdById: 'user-1',
    ...extra,
  });

  const createDto = (extra: Record<string, unknown> = {}) => ({
    code: ' prot-01 ',
    name: ' Protector solar ',
    price: '25.00',
    taxRatePercent: 15,
    tracksExpiry: true,
    ...extra,
  });

  async function failure(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error as { getStatus(): number; getResponse(): Record<string, unknown> };
    }
    throw new Error('expected the call to fail');
  }

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.tenantSettings.findUnique.mockResolvedValue({ timezone: 'America/Guayaquil' });
    prisma.product.create.mockImplementation(({ data }) => productRow(data));
    prisma.product.findFirst.mockResolvedValue(productRow());
    prisma.stockLot.findMany.mockResolvedValue([]);
    prisma.branch.findMany.mockResolvedValue([]);
  });

  describe('create', () => {
    it('stores the normalized product and audits it', async () => {
      const result = await service.create('tenant-1', 'user-1', createDto());

      const { data } = prisma.product.create.mock.calls[0][0];
      expect(data).toMatchObject({
        tenantId: 'tenant-1',
        code: 'PROT-01',
        name: 'Protector solar',
        price: '25.00',
        taxRatePercent: 15,
        minStock: 0,
        createdById: 'user-1',
      });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'CREATE',
        entity: 'PRODUCT',
        entityId: 'product-1',
      });
      expect(result.price).toBe('25.00');
    });

    it('rejects a code that a treatment already has, ignoring case and spaces', async () => {
      prisma.treatment.findFirst.mockResolvedValue({ id: 'treatment-1' });

      const error = await failure(
        service.create('tenant-1', 'user-1', createDto({ code: ' btx-01 ' })),
      );

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'PRODUCT_CODE_TAKEN' });
      expect(prisma.treatment.findFirst.mock.calls[0][0].where).toMatchObject({
        tenantId: 'tenant-1',
        code: 'BTX-01',
      });
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it.each([
      ['code', { target: ['tenantId', 'code'] }, 'PRODUCT_CODE_TAKEN'],
      ['name', { target: ['tenantId', 'name'] }, 'PRODUCT_NAME_TAKEN'],
      ['barcode index', { target: 'Product_tenant_barcode_key' }, 'PRODUCT_BARCODE_TAKEN'],
      ['barcode column', { target: ['tenantId', 'barcode'] }, 'PRODUCT_BARCODE_TAKEN'],
      ['barcode constraint', { constraint: 'Product_tenant_barcode_key' }, 'PRODUCT_BARCODE_TAKEN'],
    ])('maps a unique violation on %s to %s', async (_label, meta, expected) => {
      prisma.product.create.mockRejectedValue({ code: 'P2002', meta });

      const error = await failure(service.create('tenant-1', 'user-1', createDto()));

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: expected });
    });
  });

  describe('create validation', () => {
    it('classifies by the target even when the message quotes other fields', async () => {
      prisma.product.create.mockRejectedValue({
        code: 'P2002',
        message: [
          'Invalid `tx.product.create()` invocation:',
          '',
          '  code,',
          '  barcode: dto.barcode?.trim() || null,',
          '',
          'Unique constraint failed on the fields: (`tenantId`,`name`)',
        ].join('\n'),
        meta: { target: ['tenantId', 'name'] },
      });

      const error = await failure(service.create('tenant-1', 'user-1', createDto()));

      expect(error.getResponse()).toMatchObject({ code: 'PRODUCT_NAME_TAKEN' });
    });

    it('rejects an unsupported tax rate with 422 TAX_RATE_UNSUPPORTED', async () => {
      const error = await failure(
        service.create('tenant-1', 'user-1', createDto({ taxRatePercent: 12 })),
      );

      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ code: 'TAX_RATE_UNSUPPORTED' });
      expect(prisma.product.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects an unsupported tax rate with 422 TAX_RATE_UNSUPPORTED', async () => {
      const error = await failure(
        service.update('tenant-1', 'user-1', 'product-1', { taxRatePercent: 14 }),
      );

      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ code: 'TAX_RATE_UNSUPPORTED' });
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('refuses to change tracksExpiry once the product has lots', async () => {
      prisma.stockLot.count.mockResolvedValue(1);

      const error = await failure(
        service.update('tenant-1', 'user-1', 'product-1', { tracksExpiry: false }),
      );

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'PRODUCT_HAS_STOCK' });
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('lets tracksExpiry stay as it is even with lots', async () => {
      prisma.stockLot.count.mockResolvedValue(3);
      prisma.product.update.mockResolvedValue(productRow());

      await service.update('tenant-1', 'user-1', 'product-1', {
        tracksExpiry: true,
        name: ' Otro ',
      });

      expect(prisma.product.update.mock.calls[0][0].data).toMatchObject({ name: 'Otro' });
    });

    it('rejects a new code that a treatment has', async () => {
      prisma.treatment.findFirst.mockResolvedValue({ id: 'treatment-1' });

      const error = await failure(
        service.update('tenant-1', 'user-1', 'product-1', { code: 'btx-01' }),
      );

      expect(error.getResponse()).toMatchObject({ code: 'PRODUCT_CODE_TAKEN' });
    });

    it('answers 404 PRODUCT_NOT_FOUND for a product of another clinic', async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      const error = await failure(service.update('tenant-1', 'user-1', 'x', { name: 'Nuevo' }));

      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    });
  });

  describe('listForSale', () => {
    const lot = (extra: Record<string, unknown>) => ({
      productId: 'product-1',
      quantityOnHand: 4,
      expiresAt: null,
      ...extra,
    });

    it('returns only active products, without any cost, counting unexpired stock', async () => {
      prisma.product.findMany.mockResolvedValue([productRow()]);
      prisma.stockLot.findMany.mockResolvedValue([
        lot({ quantityOnHand: 3, expiresAt: new Date('2026-12-01T00:00:00Z') }),
        lot({ quantityOnHand: 2, expiresAt: new Date('2026-10-25T00:00:00Z') }),
        lot({ quantityOnHand: 5, unitCost: D('9.99') }),
      ]);

      const result = await service.listForSale('tenant-1', { branchId: 'branch-1' });

      expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: 'tenant-1',
        isActive: true,
      });
      expect(prisma.product.findMany.mock.calls[0][0].take).toBe(20);
      expect(result).toEqual([
        {
          id: 'product-1',
          code: 'PROT-01',
          name: 'Protector solar',
          barcode: null,
          price: '25.00',
          taxRatePercent: 15,
          available: 8,
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('unitCost');
    });

    it('looks a barcode up exactly, trimmed', async () => {
      prisma.product.findMany.mockResolvedValue([]);

      await service.listForSale('tenant-1', { branchId: 'branch-1', barcode: ' 750123 ' });

      expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({ barcode: '750123' });
    });

    it('searches name or code without caring about case', async () => {
      prisma.product.findMany.mockResolvedValue([]);

      await service.listForSale('tenant-1', { branchId: 'branch-1', search: 'sol' });

      expect(prisma.product.findMany.mock.calls[0][0].where.OR).toEqual([
        { name: { contains: 'sol', mode: 'insensitive' } },
        { code: { contains: 'sol', mode: 'insensitive' } },
      ]);
    });
  });

  describe('list', () => {
    it('flags belowMin when available stock is under a positive minimum', async () => {
      prisma.product.findMany.mockResolvedValue([
        productRow({ id: 'low', minStock: 5 }),
        productRow({ id: 'ok', minStock: 2 }),
        productRow({ id: 'none', minStock: 0 }),
      ]);
      prisma.product.count.mockResolvedValue(3);
      prisma.branch.findMany.mockResolvedValue([{ id: 'branch-1', name: 'Norte' }]);
      const lot = (productId: string, quantityOnHand: number) => ({
        productId,
        branchId: 'branch-1',
        quantityOnHand,
        expiresAt: null,
      });
      prisma.stockLot.findMany.mockResolvedValue([lot('low', 4), lot('ok', 2)]);

      const result = await service.list('tenant-1', {});

      expect(result).toMatchObject({ total: 3, page: 1, pageSize: 20 });
      const stockOf = (id: string) => result.items.find((item) => item.id === id)!.stock;
      expect(stockOf('low')).toEqual([
        { branchId: 'branch-1', branchName: 'Norte', available: 4, belowMin: true },
      ]);
      expect(stockOf('ok')[0].belowMin).toBe(false);
      expect(stockOf('none')).toEqual([
        { branchId: 'branch-1', branchName: 'Norte', available: 0, belowMin: false },
      ]);
    });
  });

  describe('setActive', () => {
    it('changes the state and audits it', async () => {
      prisma.product.findFirst
        .mockResolvedValueOnce(productRow())
        .mockResolvedValueOnce(productRow({ isActive: false }));
      prisma.product.update.mockResolvedValue({});

      const result = await service.setActive('tenant-1', 'user-1', 'product-1', {
        isActive: false,
      });

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 'product-1' },
        data: { isActive: false },
      });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'UPDATE',
        entity: 'PRODUCT',
        changes: { isActive: false },
      });
      expect(result.isActive).toBe(false);
    });
  });
});
