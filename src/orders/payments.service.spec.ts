import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from './payments.service';

const D = (value: string) => new Prisma.Decimal(value);

describe('PaymentsService', () => {
  const prisma = {
    invoiceRequest: { findFirst: jest.fn() },
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    auditLog: { create: jest.fn() },
    cashRegisterSession: { findFirst: jest.fn() },
    order: { findFirst: jest.fn(), update: jest.fn() },
    payment: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  const service = new PaymentsService(prisma as unknown as PrismaService);

  const person = { id: 'user-1', firstName: 'Ana', lastName: 'Paz' };

  type Row = Record<string, unknown> & { payments: Record<string, unknown>[] };
  let order: Row;
  let payments: Record<string, unknown>[];

  const makeOrder = (extra: Record<string, unknown> = {}): Row => ({
    id: 'order-1',
    tenantId: 'tenant-1',
    number: 7,
    status: 'OPEN',
    branchId: 'branch-1',
    billingProfile: null,
    subtotal: D('20'),
    discountTotal: D('0'),
    taxTotal: D('3'),
    total: D('23'),
    paidTotal: D('0'),
    version: 1,
    createdAt: new Date('2026-10-15T10:00:00Z'),
    items: [],
    payments: [],
    ...extra,
  });

  const storedPayment = (extra: Record<string, unknown> = {}) => ({
    id: 'payment-1',
    tenantId: 'tenant-1',
    orderId: 'order-1',
    cashRegisterSessionId: 'cash-1',
    method: 'CASH',
    amount: D('10'),
    reference: null,
    status: 'RECORDED',
    idempotencyKey: null,
    receivedBy: person,
    receivedAt: new Date('2026-10-15T11:00:00Z'),
    refundedAt: null,
    refundReason: null,
    ...extra,
  });

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: { getResponse: () => { code: string } }) => error.getResponse().code,
    );

  const record = (amount: string, key?: string, extra: Record<string, unknown> = {}) =>
    service.record(
      'tenant-1',
      'user-1',
      'order-1',
      { method: 'CASH', amount, ...extra } as never,
      key,
    );

  beforeEach(() => {
    jest.resetAllMocks();
    order = makeOrder();
    payments = [];
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
      callback(prisma),
    );
    prisma.order.findFirst.mockImplementation(() =>
      Promise.resolve({ ...order, payments: [...payments] }),
    );
    prisma.order.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const { version, ...rest } = data;
      order = { ...order, ...rest, version: order.version as number };
      if (version) order.version = (order.version as number) + 1;
      return Promise.resolve({});
    });
    prisma.cashRegisterSession.findFirst.mockResolvedValue({ id: 'cash-1' });
    prisma.payment.findFirst.mockImplementation(
      ({ where }: { where: { id?: string; idempotencyKey?: string } }) =>
        Promise.resolve(
          payments.find(
            (p) =>
              (where.id === undefined || p.id === where.id) &&
              (where.idempotencyKey === undefined || p.idempotencyKey === where.idempotencyKey),
          ) ?? null,
        ),
    );
    prisma.payment.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const created = storedPayment({
        id: `payment-${payments.length + 1}`,
        ...data,
        amount: D(data.amount as string),
      });
      payments.push(created);
      return Promise.resolve(created);
    });
    prisma.payment.update.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const found = payments.find((p) => p.id === where.id)!;
        Object.assign(found, data);
        return Promise.resolve(found);
      },
    );
  });

  describe('record', () => {
    it('two partial payments settle the order', async () => {
      const first = await record('10.00');
      expect(first.status).toBe('OPEN');
      expect(first.balance).toBe('13.00');

      const second = await record('13.00');
      expect(second.status).toBe('PAID');
      expect(second.paidTotal).toBe('23.00');
      expect(second.balance).toBe('0.00');
      expect(second.version).toBe(3);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        entity: 'PAYMENT',
        action: 'CREATE',
      });
    });

    it('records the payment in the open register of the order branch', async () => {
      await record('10.00', undefined, { reference: 'REF-1' });
      expect(prisma.cashRegisterSession.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', branchId: 'branch-1', status: 'OPEN' },
      });
      expect(prisma.payment.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        orderId: 'order-1',
        cashRegisterSessionId: 'cash-1',
        receivedById: 'user-1',
        reference: 'REF-1',
      });
    });

    it('rejects an amount above the balance', async () => {
      expect(await rejection(record('23.01'))).toBe('PAYMENT_EXCEEDS_BALANCE');
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('rejects when the branch has no open register', async () => {
      prisma.cashRegisterSession.findFirst.mockResolvedValue(null);
      expect(await rejection(record('10.00'))).toBe('CASH_REGISTER_CLOSED');
    });

    it('rejects paying an order that is not open', async () => {
      order = makeOrder({ status: 'PAID', paidTotal: D('23') });
      expect(await rejection(record('1.00'))).toBe('ORDER_NOT_EDITABLE');
    });

    it('the same key and body yields a single payment', async () => {
      await record('10.00', 'key-1');
      const again = await record('10.00', 'key-1');
      expect(payments).toHaveLength(1);
      expect(again.paidTotal).toBe('10.00');
      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    });

    it('the same key with another amount is rejected', async () => {
      await record('10.00', 'key-1');
      expect(await rejection(record('11.00', 'key-1'))).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(payments).toHaveLength(1);
    });

    it('resolves a concurrent duplicate key like a repeated key', async () => {
      const existing = storedPayment({ idempotencyKey: 'key-1' });
      order = makeOrder({ paidTotal: D('10') });
      let lookups = 0;
      prisma.payment.findFirst.mockImplementation(() =>
        Promise.resolve(lookups++ === 0 ? null : existing),
      );
      prisma.payment.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );
      const view = await record('10.00', 'key-1');
      expect(view.paidTotal).toBe('10.00');
    });
  });

  describe('refund', () => {
    const refund = () => service.refund('tenant-1', 'user-1', 'payment-1', { reason: 'Error' });

    it('reopens the order, marks the payment and credits the refund register', async () => {
      await record('23.00');
      expect(order.status).toBe('PAID');
      prisma.cashRegisterSession.findFirst.mockResolvedValue({ id: 'cash-2' });

      const view = await refund();

      expect(view.status).toBe('OPEN');
      expect(view.paidTotal).toBe('0.00');
      expect(payments[0]).toMatchObject({
        status: 'REFUNDED',
        refundedById: 'user-1',
        refundReason: 'Error',
        refundCashRegisterSessionId: 'cash-2',
      });
      expect(prisma.auditLog.create.mock.calls.at(-1)![0].data).toMatchObject({
        entity: 'PAYMENT',
        action: 'UPDATE',
        reason: 'Error',
      });
    });

    it('keeps the order open with the paid total reduced', async () => {
      await record('10.00');
      await record('5.00');
      const view = await refund();
      expect(view.status).toBe('OPEN');
      expect(view.paidTotal).toBe('5.00');
    });

    it('refuses a second refund', async () => {
      await record('10.00');
      await refund();
      expect(await rejection(refund())).toBe('PAYMENT_NOT_REFUNDABLE');
    });

    it('refuses when the order is cancelled', async () => {
      await record('10.00');
      order = makeOrder({ status: 'CANCELLED', paidTotal: D('10') });
      expect(await rejection(refund())).toBe('PAYMENT_NOT_REFUNDABLE');
    });

    it('404 for an unknown payment', async () => {
      expect(await rejection(service.refund('tenant-1', 'user-1', 'nope', { reason: 'x' }))).toBe(
        'PAYMENT_NOT_FOUND',
      );
    });

    it('rejects when the branch has no open register', async () => {
      await record('10.00');
      prisma.cashRegisterSession.findFirst.mockResolvedValue(null);
      expect(await rejection(refund())).toBe('CASH_REGISTER_CLOSED');
    });
  });
});
