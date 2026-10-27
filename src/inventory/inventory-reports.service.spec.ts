import { ValidationPipe } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExpiringReportQuery } from './dto/inventory-reports.dto';
import { InventoryReportsService } from './inventory-reports.service';

const D = (value: string) => new Prisma.Decimal(value);
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe('InventoryReportsService', () => {
  const prisma = {
    tenantSettings: { findUnique: jest.fn() },
    stockLot: { findMany: jest.fn() },
    product: { findMany: jest.fn() },
    branch: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
  };
  const service = new InventoryReportsService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-26T15:00:00Z'));
    prisma.tenantSettings.findUnique.mockResolvedValue({ timezone: 'America/Guayaquil' });
  });
  afterEach(() => jest.useRealTimers());

  async function failure(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error as { getStatus(): number; getResponse(): Record<string, unknown> };
    }
    throw new Error('expected the call to fail');
  }

  describe('valuation', () => {
    it('adds the lots of each branch separately and totals them', async () => {
      const lot = (
        branchId: string,
        productId: string,
        quantityOnHand: number,
        unitCost: string,
      ) => ({
        branchId,
        productId,
        quantityOnHand,
        unitCost: D(unitCost),
        branch: { name: branchId === 'b1' ? 'Centro' : 'Norte' },
        product: { code: productId.toUpperCase(), name: `Producto ${productId}` },
      });
      prisma.stockLot.findMany.mockResolvedValue([
        lot('b1', 'p1', 2, '1.10'),
        lot('b1', 'p1', 3, '2.00'),
        lot('b2', 'p1', 4, '1.10'),
      ]);

      const report = await service.valuation('t1', {});

      expect(report.branches).toEqual([
        {
          branchId: 'b1',
          branchName: 'Centro',
          units: 5,
          value: '8.20',
          products: [{ productId: 'p1', code: 'P1', name: 'Producto p1', units: 5, value: '8.20' }],
        },
        {
          branchId: 'b2',
          branchName: 'Norte',
          units: 4,
          value: '4.40',
          products: [{ productId: 'p1', code: 'P1', name: 'Producto p1', units: 4, value: '4.40' }],
        },
      ]);
      expect(report.totalValue).toBe('12.60');
    });

    it('filters by branch', async () => {
      prisma.stockLot.findMany.mockResolvedValue([]);
      await service.valuation('t1', { branchId: 'b2' });
      expect(prisma.stockLot.findMany.mock.calls[0][0].where).toMatchObject({ branchId: 'b2' });
    });
  });

  describe('expiring', () => {
    const lot = (id: string, expiresAt: string) => ({
      id,
      lotNumber: id,
      expiresAt: date(expiresAt),
      quantityOnHand: 3,
      unitCost: D('1.50'),
      product: { id: 'p1', code: 'P1', name: 'Gel' },
      branch: { id: 'b1', name: 'Centro' },
    });

    it('splits expired lots from those expiring within the window (today is 2026-10-26)', async () => {
      prisma.stockLot.findMany.mockResolvedValue([
        lot('old', '2026-10-25'),
        lot('soon', '2026-11-20'),
      ]);
      // clinicToday reads the zone from tenantSettings
      const report = await service.expiring('t1', { days: 30 });

      expect(report.expired.map((l) => l.lotId)).toEqual(['old']);
      expect(report.expiring.map((l) => l.lotId)).toEqual(['soon']);
      expect(report.expiring[0].value).toBe('4.50');
      const where = prisma.stockLot.findMany.mock.calls[0][0].where;
      expect(where.expiresAt.lte).toEqual(date('2026-11-25'));
    });

    it('rejects a window other than 30, 60 or 90 with a 400 from the ValidationPipe', async () => {
      const pipe = new ValidationPipe({ transform: true });
      const meta = { type: 'query' as const, metatype: ExpiringReportQuery };
      await expect(pipe.transform({ days: '45' }, meta)).rejects.toMatchObject({ status: 400 });
      await expect(pipe.transform({ days: '60' }, meta)).resolves.toMatchObject({ days: 60 });
    });
  });

  describe('lowStock', () => {
    it('lists a branch with 0 and skips products with minStock 0 and expired balance', async () => {
      prisma.product.findMany.mockResolvedValue([
        { id: 'p1', code: 'P1', name: 'Gel', minStock: 5 },
      ]);
      prisma.branch.findMany.mockResolvedValue([
        { id: 'b1', name: 'Centro' },
        { id: 'b2', name: 'Norte' },
        { id: 'b3', name: 'Sur' },
      ]);
      prisma.stockLot.findMany.mockResolvedValue([
        { productId: 'p1', branchId: 'b1', quantityOnHand: 5, expiresAt: null },
        { productId: 'p1', branchId: 'b3', quantityOnHand: 9, expiresAt: date('2026-10-25') },
        { productId: 'p1', branchId: 'b3', quantityOnHand: 2, expiresAt: date('2026-12-01') },
      ]);

      const report = await service.lowStock('t1', {});

      expect(report).toEqual([
        {
          productId: 'p1',
          code: 'P1',
          name: 'Gel',
          branchId: 'b2',
          branchName: 'Norte',
          available: 0,
          minStock: 5,
        },
        {
          productId: 'p1',
          code: 'P1',
          name: 'Gel',
          branchId: 'b3',
          branchName: 'Sur',
          available: 2,
          minStock: 5,
        },
      ]);
      expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({
        isActive: true,
        minStock: { gt: 0 },
      });
    });
  });

  describe('margin', () => {
    const item = (extra: Record<string, unknown>) => ({
      productId: 'p1',
      quantity: D('2'),
      lineSubtotal: D('10.00'),
      order: { createdAt: new Date('2026-10-10T15:00:00Z') },
      product: { code: 'P1', name: 'Gel' },
      lots: [
        { quantity: 1, unitCost: D('1.10') },
        { quantity: 1, unitCost: D('1.40') },
      ],
      ...extra,
    });

    it('computes margin = revenue - cost, querying only paid lines that were not released', async () => {
      prisma.orderItem.findMany.mockResolvedValue([item({}), item({ lineSubtotal: D('5.00') })]);

      const report = await service.margin('t1', { from: '2026-10-01', to: '2026-10-31' });

      expect(report).toEqual({
        revenue: '15.00',
        cost: '5.00',
        margin: '10.00',
        products: [
          {
            productId: 'p1',
            code: 'P1',
            name: 'Gel',
            units: 4,
            revenue: '15.00',
            cost: '5.00',
            margin: '10.00',
          },
        ],
      });
      const where = prisma.orderItem.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        kind: 'PRODUCT',
        releasedAt: null,
        order: { status: { in: ['PAID', 'INVOICED'] } },
      });
    });

    it('takes the period inclusively in clinic days', async () => {
      prisma.orderItem.findMany.mockResolvedValue([
        // 2026-11-01 02:00Z is still Oct 31 in Guayaquil (UTC-5): inside
        item({ order: { createdAt: new Date('2026-11-01T02:00:00Z') } }),
        // 2026-11-01 06:00Z is Nov 1 locally: outside
        item({ order: { createdAt: new Date('2026-11-01T06:00:00Z') } }),
      ]);

      const report = await service.margin('t1', { from: '2026-10-01', to: '2026-10-31' });

      expect(report.revenue).toBe('10.00');
    });

    it('rejects a period longer than 366 days', async () => {
      const error = await failure(service.margin('t1', { from: '2025-09-01', to: '2026-10-05' }));
      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ code: 'REPORT_RANGE_TOO_LONG' });
      expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
    });

    it('accepts exactly 366 days', async () => {
      prisma.orderItem.findMany.mockResolvedValue([]);
      await expect(
        service.margin('t1', { from: '2025-10-01', to: '2026-10-01' }),
      ).resolves.toMatchObject({ margin: '0.00' });
    });
  });
});
