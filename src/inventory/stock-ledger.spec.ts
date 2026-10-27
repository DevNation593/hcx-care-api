import { Prisma } from '@prisma/client';
import { addToLot, MovementInput, recordInitialMovement, takeFromLot } from './stock-ledger';

const D = (value: string) => new Prisma.Decimal(value);

describe('stock ledger', () => {
  const tx = {
    stockLot: { updateMany: jest.fn(), update: jest.fn() },
    stockMovement: { create: jest.fn() },
  };
  const client = tx as unknown as Prisma.TransactionClient;

  const input = (extra: Partial<MovementInput> = {}): MovementInput => ({
    tenantId: 'tenant-1',
    actorId: 'user-1',
    lotId: 'lot-1',
    productId: 'product-1',
    branchId: 'branch-1',
    kind: 'SALE',
    quantity: -2,
    unitCost: D('4.50'),
    orderItemId: 'item-1',
    ...extra,
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('takes from a lot only while it keeps enough units and records the movement', async () => {
    tx.stockLot.updateMany.mockResolvedValue({ count: 1 });

    await expect(takeFromLot(client, input())).resolves.toBe(true);

    expect(tx.stockLot.updateMany).toHaveBeenCalledWith({
      where: { id: 'lot-1', tenantId: 'tenant-1', quantityOnHand: { gte: 2 } },
      data: { quantityOnHand: { decrement: 2 } },
    });
    expect(tx.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        kind: 'SALE',
        lotId: 'lot-1',
        productId: 'product-1',
        branchId: 'branch-1',
        quantity: -2,
        unitCost: D('4.50'),
        orderItemId: 'item-1',
        createdById: 'user-1',
      }),
    });
  });

  it('reports a lost race without writing the movement', async () => {
    tx.stockLot.updateMany.mockResolvedValue({ count: 0 });

    await expect(takeFromLot(client, input())).resolves.toBe(false);

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('adds units back to a lot and records the movement', async () => {
    tx.stockLot.updateMany.mockResolvedValue({ count: 1 });

    await addToLot(client, input({ kind: 'SALE_RELEASE', quantity: 3 }));

    expect(tx.stockLot.updateMany).toHaveBeenCalledWith({
      where: { id: 'lot-1', tenantId: 'tenant-1' },
      data: { quantityOnHand: { increment: 3 } },
    });
    expect(tx.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'SALE_RELEASE', quantity: 3, lotId: 'lot-1' }),
    });
  });

  it('refuses to add units to a lot outside the tenant', async () => {
    tx.stockLot.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      addToLot(client, input({ kind: 'SALE_RELEASE', quantity: 3 })),
    ).rejects.toMatchObject({
      response: { code: 'STOCK_LOT_NOT_FOUND' },
    });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it.each([0, 2, -1.5, Number.NaN])('takeFromLot rejects a quantity of %s', async (quantity) => {
    await expect(takeFromLot(client, input({ quantity }))).rejects.toThrow(/negative integer/);
    expect(tx.stockLot.updateMany).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it.each([0, -3, 1.5, Number.NaN])('addToLot rejects a quantity of %s', async (quantity) => {
    await expect(addToLot(client, input({ kind: 'ADJUSTMENT', quantity }))).rejects.toThrow(
      /positive integer/,
    );
    expect(tx.stockLot.updateMany).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('records the initial movement of a new lot without touching its balance', async () => {
    await recordInitialMovement(
      client,
      input({ kind: 'RECEIPT', quantity: 10, receiptId: 'receipt-1' }),
    );

    expect(tx.stockLot.updateMany).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'RECEIPT', quantity: 10, receiptId: 'receipt-1' }),
    });
  });
});
