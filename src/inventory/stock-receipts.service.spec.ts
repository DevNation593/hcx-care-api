import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockReceiptDto } from './dto/stock-receipt.dto';
import { StockReceiptsService } from './stock-receipts.service';

const D = (value: string) => new Prisma.Decimal(value);

describe('StockReceiptsService', () => {
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    auditLog: { create: jest.fn() },
    tenantSettings: { findUnique: jest.fn() },
    branch: { findFirst: jest.fn() },
    product: { findMany: jest.fn() },
    stockReceipt: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    stockLot: { create: jest.fn(), findMany: jest.fn() },
    stockMovement: { create: jest.fn() },
  };
  const service = new StockReceiptsService(prisma as unknown as PrismaService);

  const product = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    code: `C-${id}`,
    name: `Producto ${id}`,
    tracksExpiry: false,
    isActive: true,
    ...extra,
  });

  const dto = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    ({
      branchId: 'branch-1',
      lines,
      ...extra,
    }) as unknown as CreateStockReceiptDto;

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
    // 2026-10-26 12:00 in Guayaquil; "today" is computed from the real clock below.
    prisma.tenantSettings.findUnique.mockResolvedValue({ timezone: 'America/Guayaquil' });
    prisma.branch.findFirst.mockResolvedValue({ id: 'branch-1' });
    prisma.product.findMany.mockResolvedValue([product('p1'), product('p2')]);
    prisma.stockReceipt.create.mockImplementation(({ data }) => ({
      id: 'receipt-1',
      ...data,
      createdAt: new Date(),
    }));
    let lotSeq = 0;
    prisma.stockLot.create.mockImplementation(({ data }) => ({ id: `lot-${++lotSeq}`, ...data }));
    prisma.stockMovement.create.mockResolvedValue({});
    prisma.stockReceipt.findFirst.mockResolvedValue(null);
  });

  const todayString = () => {
    // Same value clinicToday computes: the clinic calendar date.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Guayaquil',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  };
  const shiftDay = (date: string, days: number) => {
    const moved = new Date(`${date}T00:00:00Z`);
    moved.setUTCDate(moved.getUTCDate() + days);
    return moved.toISOString().slice(0, 10);
  };

  describe('create', () => {
    beforeEach(() => {
      // The view is read back after the write.
      prisma.stockReceipt.findFirst.mockImplementation(async () => ({
        id: 'receipt-1',
        branch: { id: 'branch-1', name: 'Matriz' },
        supplierName: null,
        documentNumber: null,
        receivedAt: new Date(),
        note: null,
        createdBy: { id: 'user-1', firstName: 'Ana', lastName: 'Paz' },
        lots: [],
      }));
    });

    it('creates one lot and one RECEIPT movement per line, with its cost', async () => {
      await service.create(
        'tenant-1',
        'user-1',
        dto([
          { productId: 'p1', quantity: 5, unitCost: '2.50', lotNumber: 'L-1' },
          { productId: 'p2', quantity: 3, unitCost: '10.00' },
        ]),
      );

      expect(prisma.stockLot.create).toHaveBeenCalledTimes(2);
      expect(prisma.stockLot.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        productId: 'p1',
        branchId: 'branch-1',
        lotNumber: 'L-1',
        quantityReceived: 5,
        quantityOnHand: 5,
        receiptId: 'receipt-1',
      });
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(2);
      const movements = prisma.stockMovement.create.mock.calls.map((call) => call[0].data);
      expect(movements[0]).toMatchObject({
        kind: 'RECEIPT',
        lotId: 'lot-1',
        productId: 'p1',
        quantity: 5,
        receiptId: 'receipt-1',
        createdById: 'user-1',
      });
      expect(String(movements[0].unitCost)).toBe('2.5');
      expect(movements[1]).toMatchObject({ kind: 'RECEIPT', lotId: 'lot-2', quantity: 3 });
      expect(String(movements[1].unitCost)).toBe('10');
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        entity: 'STOCK_RECEIPT',
        action: 'CREATE',
        entityId: 'receipt-1',
      });
    });

    it('requires an expiry date when the product tracks it', async () => {
      prisma.product.findMany.mockResolvedValue([product('p1', { tracksExpiry: true })]);

      const error = await failure(
        service.create(
          'tenant-1',
          'user-1',
          dto([{ productId: 'p1', quantity: 1, unitCost: '1.00' }]),
        ),
      );

      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ code: 'LOT_EXPIRY_REQUIRED' });
      expect(prisma.stockLot.create).not.toHaveBeenCalled();
    });

    it('rejects an expiry date before the clinic today but accepts today', async () => {
      prisma.product.findMany.mockResolvedValue([product('p1', { tracksExpiry: true })]);
      const today = todayString();
      const line = (expiresAt: string) => ({
        productId: 'p1',
        quantity: 1,
        unitCost: '1.00',
        expiresAt,
      });

      const error = await failure(
        service.create('tenant-1', 'user-1', dto([line(shiftDay(today, -1))])),
      );
      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({ code: 'LOT_ALREADY_EXPIRED' });

      await service.create('tenant-1', 'user-1', dto([line(today)]));
      const { data } = prisma.stockLot.create.mock.calls[0][0];
      expect(data.expiresAt).toEqual(new Date(`${today}T00:00:00.000Z`));
    });

    it('rejects an unavailable branch', async () => {
      prisma.branch.findFirst.mockResolvedValue(null);

      const error = await failure(
        service.create(
          'tenant-1',
          'user-1',
          dto([{ productId: 'p1', quantity: 1, unitCost: '1.00' }]),
        ),
      );

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ code: 'BRANCH_NOT_AVAILABLE' });
    });

    it('rejects an inactive product', async () => {
      prisma.product.findMany.mockResolvedValue([product('p1', { isActive: false })]);

      const error = await failure(
        service.create(
          'tenant-1',
          'user-1',
          dto([{ productId: 'p1', quantity: 1, unitCost: '1.00' }]),
        ),
      );

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'PRODUCT_INACTIVE' });
    });

    it('rejects a product of another tenant as not found', async () => {
      prisma.product.findMany.mockResolvedValue([]);

      const error = await failure(
        service.create(
          'tenant-1',
          'user-1',
          dto([{ productId: 'p9', quantity: 1, unitCost: '1.00' }]),
        ),
      );

      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    });
  });
});
