import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CashRegistersService, findOpenCashRegister } from './cash-registers.service';

describe('CashRegistersService', () => {
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    auditLog: { create: jest.fn() },
    branch: { findFirst: jest.fn() },
    cashRegisterSession: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: { findMany: jest.fn() },
  };
  const service = new CashRegistersService(prisma as unknown as PrismaService);

  const session = (extra: Record<string, unknown> = {}) => ({
    id: 'cash-1',
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    status: 'OPEN',
    openedById: 'user-1',
    openedAt: new Date('2026-10-15T08:00:00Z'),
    openingCash: new Prisma.Decimal('50'),
    closedById: null,
    closedAt: null,
    expectedCash: null,
    countedCash: null,
    difference: null,
    closingNote: null,
    ...extra,
  });

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: { getResponse: () => { code: string } }) => error.getResponse().code,
    );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
      callback(prisma),
    );
    prisma.branch.findFirst.mockResolvedValue({ id: 'branch-1' });
    prisma.cashRegisterSession.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(session(data)),
    );
    prisma.cashRegisterSession.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => Promise.resolve(session(data)),
    );
    prisma.payment.findMany.mockResolvedValue([]);
  });

  describe('open', () => {
    const dto = { branchId: 'branch-1', openingCash: '50.00' };

    it('opens the register of an active branch of the tenant and audits it', async () => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue(null);

      const result = await service.open('tenant-1', 'user-1', dto);

      expect(prisma.branch.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'branch-1', tenantId: 'tenant-1', isActive: true },
        }),
      );
      expect(result.status).toBe('OPEN');
      expect(result.openingCash).toBe('50.00');
      expect(result.summary.expectedCash).toBe('50.00');
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'CREATE',
        entity: 'CASH_REGISTER',
        entityId: 'cash-1',
      });
    });

    it('rejects a second opening in the branch', async () => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue({ id: 'cash-0' });

      expect(await rejection(service.open('tenant-1', 'user-1', dto))).toBe(
        'CASH_REGISTER_ALREADY_OPEN',
      );
      expect(prisma.cashRegisterSession.create).not.toHaveBeenCalled();
    });

    it('translates a unique violation of the partial index into the same conflict', async () => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue(null);
      prisma.cashRegisterSession.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }),
      );

      expect(await rejection(service.open('tenant-1', 'user-1', dto))).toBe(
        'CASH_REGISTER_ALREADY_OPEN',
      );
    });

    it('does not find a branch of another tenant or an inactive one', async () => {
      prisma.branch.findFirst.mockResolvedValue(null);

      expect(await rejection(service.open('tenant-1', 'user-1', dto))).toBe('BRANCH_NOT_FOUND');
    });
  });

  describe('close', () => {
    const closeData = () => prisma.cashRegisterSession.update.mock.calls[0][0].data;

    beforeEach(() => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue(session());
      prisma.payment.findMany
        .mockResolvedValueOnce([
          { method: 'CASH', amount: new Prisma.Decimal('100') },
          { method: 'CREDIT_CARD', amount: new Prisma.Decimal('30') },
        ])
        .mockResolvedValueOnce([{ method: 'CASH', amount: new Prisma.Decimal('20') }]);
    });

    it('closes without a note when the count matches (50 + 100 - 20 = 130)', async () => {
      const result = await service.close('tenant-1', 'user-1', 'cash-1', { countedCash: '130.00' });

      expect(closeData()).toMatchObject({ status: 'CLOSED', closedById: 'user-1' });
      expect(closeData().difference.toFixed(2)).toBe('0.00');
      expect(closeData().expectedCash.toFixed(2)).toBe('130.00');
      expect(result.summary.byMethod.CREDIT_CARD.received).toBe('30.00');
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'UPDATE',
        entity: 'CASH_REGISTER',
      });
      expect(JSON.stringify(prisma.auditLog.create.mock.calls[0][0].data.changes)).toContain(
        '"difference":"0.00"',
      );
    });

    it('asks for a note when the difference is not zero', async () => {
      expect(
        await rejection(service.close('tenant-1', 'user-1', 'cash-1', { countedCash: '128.00' })),
      ).toBe('CASH_CLOSING_NOTE_REQUIRED');
      expect(prisma.cashRegisterSession.update).not.toHaveBeenCalled();
    });

    it('stores the difference of -2.00 with the note', async () => {
      await service.close('tenant-1', 'user-1', 'cash-1', {
        countedCash: '128.00',
        closingNote: 'Faltan 2 dólares',
      });

      expect(closeData().difference.toFixed(2)).toBe('-2.00');
      expect(closeData().closingNote).toBe('Faltan 2 dólares');
    });

    it('does not close a register that is already closed', async () => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue(session({ status: 'CLOSED' }));

      expect(
        await rejection(service.close('tenant-1', 'user-1', 'cash-1', { countedCash: '130.00' })),
      ).toBe('CASH_REGISTER_CLOSED');
      expect(prisma.cashRegisterSession.update).not.toHaveBeenCalled();
    });

    it('does not find a register of another tenant', async () => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue(null);

      expect(
        await rejection(service.close('tenant-1', 'user-1', 'cash-9', { countedCash: '1.00' })),
      ).toBe('CASH_REGISTER_NOT_FOUND');
    });
  });

  describe('findOpenCashRegister', () => {
    const tx = prisma as unknown as Prisma.TransactionClient;

    it('returns the open register of the branch', async () => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue(session());

      expect((await findOpenCashRegister(tx, 'tenant-1', 'branch-1')).id).toBe('cash-1');
    });

    it('answers CASH_REGISTER_CLOSED when the branch has none', async () => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue(null);

      expect(await rejection(findOpenCashRegister(tx, 'tenant-1', 'branch-1'))).toBe(
        'CASH_REGISTER_CLOSED',
      );
    });
  });
});
