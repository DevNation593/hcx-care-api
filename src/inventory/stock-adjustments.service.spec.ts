import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockAdjustmentDto } from './dto/stock-adjustment.dto';
import { StockAdjustmentsService } from './stock-adjustments.service';

describe('StockAdjustmentsService', () => {
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    auditLog: { create: jest.fn() },
    tenantSettings: { findUnique: jest.fn() },
    stockLot: { findFirst: jest.fn(), updateMany: jest.fn() },
    stockMovement: { create: jest.fn() },
  };
  const service = new StockAdjustmentsService(prisma as unknown as PrismaService);

  const lotRow = (quantityOnHand: number) => ({
    id: 'lot-1',
    productId: 'p1',
    branchId: 'branch-1',
    lotNumber: 'L-1',
    expiresAt: null,
    unitCost: new Prisma.Decimal('4.50'),
    quantityReceived: 10,
    quantityOnHand,
    receivedAt: new Date('2026-10-01'),
  });

  const dto = (extra: Record<string, unknown>) =>
    ({ reason: 'DAMAGE', ...extra }) as unknown as CreateStockAdjustmentDto;

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
    prisma.stockLot.findFirst.mockResolvedValue(lotRow(3));
    prisma.stockLot.updateMany.mockResolvedValue({ count: 1 });
    prisma.stockMovement.create.mockResolvedValue({});
  });

  it('answers 404 for a lot of another tenant', async () => {
    prisma.stockLot.findFirst.mockResolvedValue(null);

    const error = await failure(service.adjust('tenant-1', 'user-1', 'lot-x', dto({ delta: 1 })));

    expect(error.getResponse()).toMatchObject({ code: 'STOCK_LOT_NOT_FOUND' });
    expect(prisma.stockLot.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: 'tenant-1',
    });
  });

  it('rejects a count equal to the balance', async () => {
    const error = await failure(
      service.adjust('tenant-1', 'user-1', 'lot-1', dto({ countedQuantity: 3 })),
    );

    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'ADJUSTMENT_EMPTY' });
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects a zero delta', async () => {
    const error = await failure(service.adjust('tenant-1', 'user-1', 'lot-1', dto({ delta: 0 })));

    expect(error.getResponse()).toMatchObject({ code: 'ADJUSTMENT_EMPTY' });
  });

  it('rejects giving both delta and countedQuantity, or neither', async () => {
    for (const extra of [{ delta: 1, countedQuantity: 4 }, {}]) {
      const error = await failure(service.adjust('tenant-1', 'user-1', 'lot-1', dto(extra)));
      expect(error.getStatus()).toBe(400);
    }
  });

  it('requires a note for the reason OTHER', async () => {
    const error = await failure(
      service.adjust('tenant-1', 'user-1', 'lot-1', dto({ delta: -1, reason: 'OTHER', note: ' ' })),
    );

    expect(error.getResponse()).toMatchObject({ code: 'ADJUSTMENT_NOTE_REQUIRED' });
  });

  it('refuses to leave the lot below zero', async () => {
    prisma.stockLot.updateMany.mockResolvedValue({ count: 0 });

    const error = await failure(service.adjust('tenant-1', 'user-1', 'lot-1', dto({ delta: -5 })));

    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'STOCK_BELOW_ZERO' });
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('turns a count of 1 over a balance of 3 into a movement of -2 with its reason', async () => {
    prisma.stockLot.findFirst.mockResolvedValueOnce(lotRow(3)).mockResolvedValueOnce(lotRow(1));

    const view = await service.adjust(
      'tenant-1',
      'user-1',
      'lot-1',
      dto({ countedQuantity: 1, reason: 'COUNT', note: 'Conteo mensual' }),
    );

    expect(prisma.stockLot.updateMany).toHaveBeenCalledWith({
      where: { id: 'lot-1', tenantId: 'tenant-1', quantityOnHand: { gte: 2 } },
      data: { quantityOnHand: { decrement: 2 } },
    });
    expect(prisma.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      kind: 'ADJUSTMENT',
      lotId: 'lot-1',
      productId: 'p1',
      branchId: 'branch-1',
      quantity: -2,
      adjustmentReason: 'COUNT',
      note: 'Conteo mensual',
      createdById: 'user-1',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entity: 'STOCK_ADJUSTMENT',
      entityId: 'lot-1',
    });
    expect(view).toMatchObject({ id: 'lot-1', quantityOnHand: 1, unitCost: '4.50' });
  });

  it('adds units with a positive delta', async () => {
    await service.adjust('tenant-1', 'user-1', 'lot-1', dto({ delta: 4, reason: 'COUNT' }));

    expect(prisma.stockLot.updateMany).toHaveBeenCalledWith({
      where: { id: 'lot-1', tenantId: 'tenant-1' },
      data: { quantityOnHand: { increment: 4 } },
    });
    expect(prisma.stockMovement.create.mock.calls[0][0].data).toMatchObject({
      kind: 'ADJUSTMENT',
      quantity: 4,
    });
  });
});
