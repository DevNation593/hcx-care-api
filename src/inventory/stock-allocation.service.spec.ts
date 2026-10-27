import { Prisma } from '@prisma/client';
import { StockAllocationService } from './stock-allocation.service';

const D = (value: string) => new Prisma.Decimal(value);

describe('StockAllocationService', () => {
  const tx = {
    $queryRaw: jest.fn(),
    stockLot: { updateMany: jest.fn() },
    stockMovement: { create: jest.fn() },
    orderItemLot: { create: jest.fn(), findMany: jest.fn() },
  };
  const client = tx as unknown as Prisma.TransactionClient;
  const service = new StockAllocationService();

  const TODAY = '2026-10-26';

  const lotRow = (
    id: string,
    quantityOnHand: number,
    expiresAt: string | null,
    unitCost: string,
  ) => ({
    id,
    quantityOnHand,
    expiresAt: expiresAt ? new Date(`${expiresAt}T00:00:00.000Z`) : null,
    receivedAt: new Date('2026-01-01T12:00:00.000Z'),
    unitCost: D(unitCost),
  });

  const reserveInput = (quantity: number) => ({
    tenantId: 'tenant-1',
    actorId: 'user-1',
    orderItemId: 'item-1',
    productId: 'product-1',
    branchId: 'branch-1',
    quantity,
    today: TODAY,
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
  });

  describe('reserve', () => {
    it('locks the product lots of the branch before allocating', async () => {
      tx.$queryRaw.mockResolvedValue([lotRow('lot-a', 5, null, '3.00')]);
      tx.stockLot.updateMany.mockResolvedValue({ count: 1 });

      await service.reserve(client, reserveInput(1));

      const query = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(query.sql).toContain('FROM "StockLot"');
      expect(query.sql).toContain('"quantityOnHand" > 0');
      expect(query.sql).toContain('FOR UPDATE');
      expect(query.values).toEqual(['tenant-1', 'product-1', 'branch-1']);
    });

    it('takes from the soonest-expiring lot first and records one line and one SALE per lot', async () => {
      tx.$queryRaw.mockResolvedValue([
        lotRow('lot-b', 5, '2027-06-30', '4.00'),
        lotRow('lot-a', 1, '2026-12-31', '3.50'),
      ]);
      tx.stockLot.updateMany.mockResolvedValue({ count: 1 });

      await service.reserve(client, reserveInput(2));

      expect(tx.orderItemLot.create).toHaveBeenCalledTimes(2);
      expect(tx.orderItemLot.create).toHaveBeenNthCalledWith(1, {
        data: {
          tenantId: 'tenant-1',
          orderItemId: 'item-1',
          lotId: 'lot-a',
          quantity: 1,
          unitCost: D('3.50'),
        },
      });
      expect(tx.orderItemLot.create).toHaveBeenNthCalledWith(2, {
        data: {
          tenantId: 'tenant-1',
          orderItemId: 'item-1',
          lotId: 'lot-b',
          quantity: 1,
          unitCost: D('4.00'),
        },
      });
      expect(tx.stockLot.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'lot-a', tenantId: 'tenant-1', quantityOnHand: { gte: 1 } },
        data: { quantityOnHand: { decrement: 1 } },
      });
      expect(tx.stockMovement.create).toHaveBeenCalledTimes(2);
      for (const [lotId, unitCost] of [
        ['lot-a', '3.50'],
        ['lot-b', '4.00'],
      ]) {
        expect(tx.stockMovement.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            kind: 'SALE',
            lotId,
            quantity: -1,
            unitCost: D(unitCost),
            orderItemId: 'item-1',
            productId: 'product-1',
            branchId: 'branch-1',
            createdById: 'user-1',
          }),
        });
      }
    });

    it('answers INSUFFICIENT_STOCK with the sellable units and touches no lot', async () => {
      tx.$queryRaw.mockResolvedValue([
        lotRow('lot-a', 2, '2026-12-31', '3.50'),
        lotRow('lot-old', 9, '2026-10-25', '3.00'),
      ]);

      const error = await failure(service.reserve(client, reserveInput(3)));

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'INSUFFICIENT_STOCK', available: 2 });
      expect(tx.stockLot.updateMany).not.toHaveBeenCalled();
      expect(tx.orderItemLot.create).not.toHaveBeenCalled();
      expect(tx.stockMovement.create).not.toHaveBeenCalled();
    });

    it('answers INSUFFICIENT_STOCK when another transaction drained a lot first', async () => {
      tx.$queryRaw.mockResolvedValue([
        lotRow('lot-a', 1, '2026-12-31', '3.50'),
        lotRow('lot-b', 5, '2027-06-30', '4.00'),
      ]);
      tx.stockLot.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const error = await failure(service.reserve(client, reserveInput(2)));

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'INSUFFICIENT_STOCK', available: 0 });
      expect(tx.stockLot.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('release', () => {
    it('returns every drawn unit to its lot, even an expired one', async () => {
      tx.orderItemLot.findMany.mockResolvedValue([
        {
          orderItemId: 'item-1',
          lotId: 'lot-a',
          quantity: 1,
          unitCost: D('3.50'),
          lot: {
            productId: 'product-1',
            branchId: 'branch-1',
            expiresAt: new Date('2026-10-01T00:00:00.000Z'),
          },
        },
        {
          orderItemId: 'item-1',
          lotId: 'lot-b',
          quantity: 1,
          unitCost: D('4.00'),
          lot: {
            productId: 'product-1',
            branchId: 'branch-1',
            expiresAt: new Date('2027-06-30T00:00:00.000Z'),
          },
        },
      ]);
      tx.stockLot.updateMany.mockResolvedValue({ count: 1 });

      await service.release(client, {
        tenantId: 'tenant-1',
        actorId: 'user-1',
        orderItemIds: ['item-1'],
      });

      expect(tx.orderItemLot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1', orderItemId: { in: ['item-1'] } },
        }),
      );
      expect(tx.stockLot.updateMany).toHaveBeenCalledWith({
        where: { id: 'lot-a', tenantId: 'tenant-1' },
        data: { quantityOnHand: { increment: 1 } },
      });
      expect(tx.stockLot.updateMany).toHaveBeenCalledWith({
        where: { id: 'lot-b', tenantId: 'tenant-1' },
        data: { quantityOnHand: { increment: 1 } },
      });
      expect(tx.stockMovement.create).toHaveBeenCalledTimes(2);
      for (const [lotId, unitCost] of [
        ['lot-a', '3.50'],
        ['lot-b', '4.00'],
      ]) {
        expect(tx.stockMovement.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            kind: 'SALE_RELEASE',
            lotId,
            quantity: 1,
            unitCost: D(unitCost),
            orderItemId: 'item-1',
            productId: 'product-1',
            branchId: 'branch-1',
          }),
        });
      }
    });

    it('does nothing for items without drawn lots', async () => {
      await service.release(client, { tenantId: 'tenant-1', actorId: 'user-1', orderItemIds: [] });

      expect(tx.orderItemLot.findMany).not.toHaveBeenCalled();
      expect(tx.stockLot.updateMany).not.toHaveBeenCalled();
    });
  });
});
