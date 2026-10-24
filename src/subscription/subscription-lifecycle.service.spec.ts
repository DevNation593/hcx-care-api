import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

type Row = Record<string, any>;

/** Evaluates the subset of Prisma filters the lifecycle uses, over in-memory rows. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((option) => matches(row, option));
    const value = row[key];
    if (condition === null || typeof condition !== 'object' || condition instanceof Date) {
      return value === condition || (value instanceof Date && +value === +condition);
    }
    return Object.entries(condition as Row).every(([operator, operand]) => {
      if (operator === 'not') return value !== operand;
      if (operator === 'lte') return value !== null && value !== undefined && +value <= +operand;
      if (operator === 'gt') return Number(value) > Number(operand);
      throw new Error(`Unsupported filter ${operator}`);
    });
  });
}

function table(rows: Row[]) {
  return {
    rows,
    findMany: jest.fn(async ({ where }: { where: Row }) =>
      rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    ),
    updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, data));
      return { count: hit.length };
    }),
  };
}

describe('SubscriptionLifecycleService', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
  const subscription = (id: string, overrides: Row): Row => ({
    id,
    tenantId: `tenant-${id}`,
    planId: 'plan_clinic_basic',
    plan: { id: 'plan_clinic_basic', name: 'Clínica Básico' },
    status: 'ACTIVE',
    basePrice: new Decimal(99),
    includedSpecialties: 2,
    specialtyPrice: new Decimal(15),
    currency: 'USD',
    currentPeriodStart: day('2026-10-01'),
    currentPeriodEnd: day('2026-11-01'),
    trialEndsAt: null,
    ...overrides,
  });

  let subscriptions: ReturnType<typeof table>;
  let payments: Row[];
  let events: Row[];
  let specialtyCount: number;
  let service: SubscriptionLifecycleService;

  const build = (rows: Row[]) => {
    subscriptions = table(rows);
    payments = [];
    events = [];
    const paymentTable = {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        const fresh = data.filter(
          (item) =>
            !payments.some(
              (row) =>
                row.tenantId === item.tenantId &&
                row.kind === item.kind &&
                +row.periodStart === +item.periodStart,
            ),
        );
        payments.push(...fresh.map((item) => ({ status: 'PENDING', ...item })));
        return { count: fresh.length };
      }),
    };
    const client = {
      tenantSubscription: subscriptions,
      subscriptionPayment: paymentTable,
      subscriptionEvent: { create: jest.fn(async ({ data }: { data: Row }) => events.push(data)) },
      tenantSpecialty: { count: jest.fn(async () => specialtyCount) },
    };
    const prisma = {
      ...client,
      $transaction: jest.fn(async (callback: (tx: typeof client) => unknown) => callback(client)),
    };
    service = new SubscriptionLifecycleService(prisma as unknown as PrismaService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    specialtyCount = 1;
  });

  describe('renewals', () => {
    it('issues one charge per period within the notice window, however often it runs', async () => {
      build([
        subscription('soon', { currentPeriodEnd: day('2026-10-20') }),
        subscription('later', { currentPeriodEnd: day('2026-11-15') }),
        subscription('custom', {
          plan: { id: 'plan_clinic_enterprise', name: 'Clínica Personalizado' },
          basePrice: new Decimal(0),
          currentPeriodEnd: day('2026-10-20'),
        }),
      ]);

      const first = await service.run(now);
      const second = await service.run(now);

      expect([first.renewalsIssued, second.renewalsIssued]).toEqual([1, 0]);
      expect(payments).toEqual([
        expect.objectContaining({
          tenantId: 'tenant-soon',
          kind: 'RENEWAL',
          status: 'PENDING',
          planId: 'plan_clinic_basic',
          planName: 'Clínica Básico',
          periodStart: day('2026-10-20'),
          periodEnd: day('2026-11-20'),
        }),
      ]);
      expect(Number(payments[0].amount)).toBe(99);
    });

    it('charges the specialties beyond the ones the plan includes', async () => {
      specialtyCount = 4;
      build([subscription('a', { currentPeriodEnd: day('2026-10-20') })]);

      await service.run(now);

      // 99 + 2 extra specialties at 15.
      expect(Number(payments[0].amount)).toBe(129);
    });

    it('charges the first month of the plan when a trial is about to end', async () => {
      build([
        subscription('trial', {
          status: 'TRIALING',
          trialEndsAt: day('2026-10-20'),
          currentPeriodEnd: null,
        }),
        subscription('fresh', {
          status: 'TRIALING',
          trialEndsAt: day('2026-10-30'),
          currentPeriodEnd: null,
        }),
      ]);

      const report = await service.run(now);

      expect(report.renewalsIssued).toBe(1);
      expect(payments).toEqual([
        expect.objectContaining({
          tenantId: 'tenant-trial',
          periodStart: day('2026-10-20'),
          periodEnd: day('2026-11-20'),
        }),
      ]);
    });
  });

  describe('expiry', () => {
    it('makes an ended trial read-only and blocks it after the grace period', async () => {
      build([
        subscription('t', {
          status: 'TRIALING',
          currentPeriodEnd: null,
          trialEndsAt: day('2026-10-16'),
        }),
      ]);

      await service.run(now);
      expect(subscriptions.rows[0].status).toBe('PAST_DUE');

      await service.run(day('2026-10-22'));
      expect(subscriptions.rows[0].status).toBe('PAST_DUE');

      const report = await service.run(day('2026-10-24'));
      expect(report.blocked).toBe(1);
      expect(subscriptions.rows[0].status).toBe('UNPAID');
      expect(events.map(({ eventType }) => eventType)).toEqual([
        'TRIAL_ENDED',
        'GRACE_PERIOD_ENDED',
      ]);
    });

    it('moves an unpaid period to past due and then to unpaid, once each', async () => {
      build([subscription('p', { currentPeriodEnd: day('2026-10-16') })]);

      const first = await service.run(now);
      const again = await service.run(now);
      await service.run(day('2026-10-24'));

      expect([first.enteredGrace, again.enteredGrace]).toEqual([1, 0]);
      expect(subscriptions.rows[0].status).toBe('UNPAID');
      expect(
        events.map(({ eventType, previousStatus, newStatus }) => [
          eventType,
          previousStatus,
          newStatus,
        ]),
      ).toEqual([
        ['GRACE_PERIOD_ENTERED', 'ACTIVE', 'PAST_DUE'],
        ['GRACE_PERIOD_ENDED', 'PAST_DUE', 'UNPAID'],
      ]);
    });

    it('leaves a subscription inside its period and a free custom plan untouched', async () => {
      build([
        subscription('ok', {}),
        subscription('custom', {
          basePrice: new Decimal(0),
          currentPeriodEnd: day('2026-01-01'),
        }),
      ]);

      await service.run(now);

      expect(subscriptions.rows.map(({ status }) => status)).toEqual(['ACTIVE', 'ACTIVE']);
      expect(events).toEqual([]);
    });
  });
});
