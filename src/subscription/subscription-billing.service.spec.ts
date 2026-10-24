import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { addMonth, hasRunningPaidPeriod } from './subscription-billing.rules';
import { SubscriptionBillingService } from './subscription-billing.service';

describe('subscription billing rules', () => {
  it('moves to the same day of the next month and clamps short months', () => {
    expect(addMonth(new Date('2026-10-15T10:00:00Z'))).toEqual(new Date('2026-11-15T10:00:00Z'));
    expect(addMonth(new Date('2026-01-31T10:00:00Z'))).toEqual(new Date('2026-02-28T10:00:00Z'));
    expect(addMonth(new Date('2026-12-31T10:00:00Z'))).toEqual(new Date('2027-01-31T10:00:00Z'));
  });

  it('counts only an active period that has not ended as running', () => {
    const now = new Date('2026-10-16T00:00:00Z');
    const end = new Date('2026-10-31T00:00:00Z');
    expect(hasRunningPaidPeriod({ status: 'ACTIVE', currentPeriodEnd: end }, now)).toBe(true);
    expect(hasRunningPaidPeriod({ status: 'TRIALING', currentPeriodEnd: end }, now)).toBe(false);
    expect(hasRunningPaidPeriod({ status: 'PAST_DUE', currentPeriodEnd: end }, now)).toBe(false);
    expect(
      hasRunningPaidPeriod(
        { status: 'ACTIVE', currentPeriodEnd: new Date('2026-10-10T00:00:00Z') },
        now,
      ),
    ).toBe(false);
    expect(hasRunningPaidPeriod({ status: 'ACTIVE', currentPeriodEnd: null }, now)).toBe(false);
  });
});

describe('SubscriptionBillingService', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  let subscription: Record<string, any>;
  let payments: Record<string, any>[];
  let events: Record<string, any>[];

  const matches = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === 'object' && 'not' in value
        ? row[key] !== value.not
        : row[key] === value,
    );
  const tx = {
    tenantSubscription: {
      findUniqueOrThrow: jest.fn(async () => ({ ...subscription })),
      update: jest.fn(async ({ data }) => Object.assign(subscription, data)),
    },
    subscriptionEvent: { create: jest.fn(async ({ data }) => events.push(data)) },
    subscriptionPayment: {
      findUnique: jest.fn(async ({ where }) => payments.find((row) => row.id === where.id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where }) => ({
        ...payments.find((row) => row.id === where.id)!,
      })),
      findFirst: jest.fn(async ({ where }) => payments.find((row) => matches(row, where)) ?? null),
      update: jest.fn(async ({ where, data }) =>
        Object.assign(payments.find((row) => row.id === where.id)!, data),
      ),
    },
  };
  const prisma = {
    ...tx,
    applyRlsContext: jest.fn(),
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const service = new SubscriptionBillingService(prisma as unknown as PrismaService);

  const renewal = (overrides: Record<string, any> = {}) => ({
    id: 'pay-1',
    tenantId: 'tenant-1',
    kind: 'RENEWAL',
    status: 'PENDING',
    provider: 'MANUAL',
    amount: new Decimal(99),
    planId: 'plan_clinic_basic',
    planName: 'Clínica Básico',
    periodStart: new Date('2026-10-24T00:00:00Z'),
    periodEnd: new Date('2026-11-24T00:00:00Z'),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    events = [];
    // A trial on Clínica Básico whose first month is waiting for payment.
    subscription = {
      tenantId: 'tenant-1',
      planId: 'plan_clinic_basic',
      status: 'TRIALING',
      basePrice: new Decimal(99),
      currency: 'USD',
      currentPeriodStart: new Date('2026-10-10T00:00:00Z'),
      currentPeriodEnd: null,
      trialEndsAt: new Date('2026-10-24T00:00:00Z'),
    };
    payments = [renewal()];
  });

  afterEach(() => jest.useRealTimers());

  describe('confirmPayment', () => {
    const confirm = (reference = 'TRF-1', id = 'pay-1') =>
      service.confirmPayment(id, 'support', { reference });

    it('activates the plan for the period the payment covers', async () => {
      const result = await confirm();

      expect(result.alreadyConfirmed).toBe(false);
      expect(subscription).toMatchObject({
        planId: 'plan_clinic_basic',
        status: 'ACTIVE',
        currentPeriodStart: new Date('2026-10-24T00:00:00Z'),
        currentPeriodEnd: new Date('2026-11-24T00:00:00Z'),
      });
      expect(payments[0]).toMatchObject({
        status: 'CONFIRMED',
        providerReference: 'TRF-1',
        resolvedById: 'support',
        resolvedAt: now,
      });
      expect(events.map(({ eventType }) => eventType)).toEqual([
        'SUBSCRIPTION_REACTIVATED',
        'PAYMENT_SUCCEEDED',
      ]);
    });

    it('extends an active subscription without a reactivation event', async () => {
      Object.assign(subscription, {
        status: 'ACTIVE',
        currentPeriodEnd: new Date('2026-10-24T00:00:00Z'),
      });

      await confirm();

      expect(subscription.currentPeriodEnd).toEqual(new Date('2026-11-24T00:00:00Z'));
      expect(events.map(({ eventType }) => eventType)).toEqual(['PAYMENT_SUCCEEDED']);
    });

    it('applies the same confirmation only once', async () => {
      await confirm();
      const updates = tx.tenantSubscription.update.mock.calls.length;

      const repeated = await confirm();

      expect(repeated).toMatchObject({ success: true, alreadyConfirmed: true });
      expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(updates);
      expect(events).toHaveLength(2);
    });

    it('refuses a second, different reference for a confirmed payment', async () => {
      await confirm();

      await expect(confirm('TRF-2')).rejects.toMatchObject({
        status: 409,
        response: { code: 'PAYMENT_ALREADY_CONFIRMED' },
      });
    });

    it('refuses a reference that already confirmed another payment', async () => {
      payments.push({
        id: 'other',
        tenantId: 'tenant-2',
        status: 'CONFIRMED',
        provider: 'MANUAL',
        providerReference: 'TRF-1',
      });

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        response: { code: 'PAYMENT_REFERENCE_ALREADY_USED' },
      });
      expect(subscription.status).toBe('TRIALING');
    });

    it('translates a unique-index collision into the same conflict', async () => {
      prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' });

      await expect(confirm()).rejects.toMatchObject({
        response: { code: 'PAYMENT_REFERENCE_ALREADY_USED' },
      });
    });

    it.each(['CANCELED', 'EXPIRED', 'REJECTED'])('does not apply a %s payment', async (status) => {
      payments[0].status = status;

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        response: { code: 'PAYMENT_NOT_PENDING' },
      });
      expect(subscription.status).toBe('TRIALING');
    });

    it('no longer applies an upgrade a clinic requested for itself', async () => {
      payments[0] = renewal({ kind: 'PLAN_UPGRADE', periodStart: null, periodEnd: null });

      await expect(confirm()).rejects.toMatchObject({
        status: 409,
        response: { code: 'PAYMENT_NO_LONGER_APPLICABLE' },
      });
      expect(payments[0].status).toBe('PENDING');
      expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown payment', async () => {
      await expect(confirm('TRF-1', 'missing')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('rejectPayment', () => {
    it('closes the charge without changing the subscription, and is repeatable', async () => {
      await service.rejectPayment('pay-1', 'support', 'Sin transferencia');
      await service.rejectPayment('pay-1', 'support', 'Sin transferencia');

      expect(payments[0]).toMatchObject({
        status: 'REJECTED',
        resolutionNote: 'Sin transferencia',
      });
      expect(subscription.status).toBe('TRIALING');
      expect(events.map(({ eventType }) => eventType)).toEqual(['PAYMENT_FAILED']);
    });
  });
});
