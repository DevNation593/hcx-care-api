import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateStockTransferDto } from './dto/stock-transfer.dto';
import { StockTransfersService } from './stock-transfers.service';

const D = (value: string) => new Prisma.Decimal(value);

describe('StockTransfersService', () => {
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    auditLog: { create: jest.fn() },
    branch: { findFirst: jest.fn() },
    stockTransfer: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    stockLot: { findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    stockMovement: { create: jest.fn() },
  };
  const service = new StockTransfersService(prisma as unknown as PrismaService);

  const expiresAt = new Date('2027-03-31');
  const receivedAt = new Date('2026-09-01');
  const lot = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    productId: 'p1',
    branchId: 'from-1',
    lotNumber: 'L-77',
    expiresAt,
    unitCost: D('3.20'),
    quantityOnHand: 5,
    receivedAt,
    ...extra,
  });

  const dto = (lines: { lotId: string; quantity: number }[], extra: Record<string, unknown> = {}) =>
    ({ fromBranchId: 'from-1', toBranchId: 'to-1', lines, ...extra }) as CreateStockTransferDto;

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
    prisma.branch.findFirst.mockResolvedValue({ id: 'branch' });
    prisma.stockLot.findMany.mockResolvedValue([lot('lot-a'), lot('lot-b')]);
    prisma.stockLot.updateMany.mockResolvedValue({ count: 1 });
    prisma.stockTransfer.create.mockImplementation(({ data }) => ({ id: 'transfer-1', ...data }));
    let seq = 0;
    prisma.stockLot.create.mockImplementation(({ data }) => ({ id: `new-${++seq}`, ...data }));
    prisma.stockMovement.create.mockResolvedValue({});
    prisma.stockTransfer.findFirst.mockResolvedValue({
      id: 'transfer-1',
      fromBranch: { id: 'from-1', name: 'Norte' },
      toBranch: { id: 'to-1', name: 'Sur' },
      note: null,
      createdAt: new Date(),
      createdBy: { id: 'user-1', firstName: 'Ana', lastName: 'Paz' },
      movements: [],
    });
  });

  it('rejects the same branch before touching the database', async () => {
    const error = await failure(
      service.create(
        'tenant-1',
        'user-1',
        dto([{ lotId: 'lot-a', quantity: 1 }], { toBranchId: 'from-1' }),
      ),
    );

    expect(error.getStatus()).toBe(422);
    expect(error.getResponse()).toMatchObject({ code: 'TRANSFER_SAME_BRANCH' });
    expect(prisma.stockLot.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an unavailable branch', async () => {
    prisma.branch.findFirst.mockResolvedValue(null);

    const error = await failure(
      service.create('tenant-1', 'user-1', dto([{ lotId: 'lot-a', quantity: 1 }])),
    );

    expect(error.getResponse()).toMatchObject({ code: 'BRANCH_NOT_AVAILABLE' });
  });

  it('rejects a lot of another branch without writing anything', async () => {
    prisma.stockLot.findMany.mockResolvedValue([lot('lot-a'), lot('lot-b', { branchId: 'other' })]);

    const error = await failure(
      service.create(
        'tenant-1',
        'user-1',
        dto([
          { lotId: 'lot-a', quantity: 1 },
          { lotId: 'lot-b', quantity: 1 },
        ]),
      ),
    );

    expect(error.getResponse()).toMatchObject({ code: 'LOT_NOT_IN_BRANCH' });
    expect(prisma.stockTransfer.create).not.toHaveBeenCalled();
    expect(prisma.stockLot.updateMany).not.toHaveBeenCalled();
  });

  it('answers 404 for a lot that is not of the tenant', async () => {
    const error = await failure(
      service.create('tenant-1', 'user-1', dto([{ lotId: 'lot-zzz', quantity: 1 }])),
    );

    expect(error.getResponse()).toMatchObject({ code: 'STOCK_LOT_NOT_FOUND' });
  });

  it('answers INSUFFICIENT_STOCK with the available units', async () => {
    prisma.stockLot.updateMany.mockResolvedValue({ count: 0 });

    const error = await failure(
      service.create('tenant-1', 'user-1', dto([{ lotId: 'lot-a', quantity: 9 }])),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'INSUFFICIENT_STOCK', available: 5 });
  });

  it('moves 2 units into a new lot at the destination that keeps number, expiry and cost', async () => {
    await service.create('tenant-1', 'user-1', dto([{ lotId: 'lot-a', quantity: 2 }]));

    expect(prisma.stockLot.create).toHaveBeenCalledTimes(1);
    const created = prisma.stockLot.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      tenantId: 'tenant-1',
      productId: 'p1',
      branchId: 'to-1',
      lotNumber: 'L-77',
      expiresAt,
      quantityReceived: 2,
      quantityOnHand: 2,
      sourceLotId: 'lot-a',
      receivedAt,
    });
    expect(String(created.unitCost)).toBe('3.2');

    const movements = prisma.stockMovement.create.mock.calls.map((call) => call[0].data);
    expect(movements[0]).toMatchObject({
      kind: 'TRANSFER_OUT',
      lotId: 'lot-a',
      branchId: 'from-1',
      quantity: -2,
      transferId: 'transfer-1',
    });
    expect(movements[1]).toMatchObject({
      kind: 'TRANSFER_IN',
      lotId: 'new-1',
      branchId: 'to-1',
      quantity: 2,
      transferId: 'transfer-1',
    });
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      entity: 'STOCK_TRANSFER',
      entityId: 'transfer-1',
    });
  });

  it('takes the lots in ascending id order whatever the line order', async () => {
    await service.create(
      'tenant-1',
      'user-1',
      dto([
        { lotId: 'lot-b', quantity: 1 },
        { lotId: 'lot-a', quantity: 1 },
      ]),
    );

    const taken = prisma.stockLot.updateMany.mock.calls.map((call) => call[0].where.id);
    expect(taken).toEqual(['lot-a', 'lot-b']);
  });
});
