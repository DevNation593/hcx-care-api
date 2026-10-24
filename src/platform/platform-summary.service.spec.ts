import { PlatformSummaryService } from './platform-summary.service';

const NOW = new Date('2026-10-01T12:00:00Z');
const day = (count: number) => new Date(NOW.getTime() + count * 24 * 60 * 60 * 1000);

type TenantRow = {
  id: string;
  name: string;
  isActive: boolean;
  isPlatform: boolean;
  createdAt: Date;
};
type SubscriptionRow = {
  tenantId: string;
  plan: { name: string };
  status: string;
  trialEndsAt: Date | null;
};
type PaymentRow = { tenantId: string; status: string; amount: number; currency: string };

function tenant(id: string, overrides: Partial<TenantRow> = {}): TenantRow {
  return {
    id,
    name: `Clinic ${id}`,
    isActive: true,
    isPlatform: false,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function subscription(tenantId: string, overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    tenantId,
    plan: { name: 'Clínica Básico' },
    status: 'ACTIVE',
    trialEndsAt: null,
    ...overrides,
  };
}

/** In-memory stand-in that honours the filters the summary relies on. */
function fakePrisma(data: {
  tenants: TenantRow[];
  subscriptions: SubscriptionRow[];
  payments: PaymentRow[];
}) {
  const clinic = (id: string) => {
    const found = data.tenants.find((t) => t.id === id);
    return !!found && !found.isPlatform;
  };
  return {
    tenant: {
      count: jest.fn(
        async ({ where }: any) =>
          data.tenants.filter(
            (t) => t.isPlatform === where.isPlatform && t.isActive === where.isActive,
          ).length,
      ),
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        expect(orderBy).toEqual({ createdAt: 'desc' });
        return data.tenants
          .filter((t) => t.isPlatform === where.isPlatform)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, take)
          .map((t) => ({
            id: t.id,
            name: t.name,
            createdAt: t.createdAt,
            subscription: data.subscriptions.find((s) => s.tenantId === t.id) ?? null,
          }));
      }),
    },
    tenantSubscription: {
      groupBy: jest.fn(async () => {
        const counts = new Map<string, number>();
        for (const s of data.subscriptions.filter((s) => clinic(s.tenantId))) {
          counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
        }
        return [...counts].map(([status, count]) => ({ status, _count: { _all: count } }));
      }),
      findMany: jest.fn(async ({ where, orderBy }: any) => {
        expect(orderBy).toEqual({ trialEndsAt: 'asc' });
        return data.subscriptions
          .filter(
            (s) =>
              clinic(s.tenantId) &&
              s.status === where.status &&
              s.trialEndsAt !== null &&
              s.trialEndsAt >= where.trialEndsAt.gte &&
              s.trialEndsAt <= where.trialEndsAt.lte,
          )
          .sort((a, b) => a.trialEndsAt!.getTime() - b.trialEndsAt!.getTime())
          .map((s) => ({
            trialEndsAt: s.trialEndsAt,
            tenant: data.tenants.find((t) => t.id === s.tenantId),
          }));
      }),
    },
    subscriptionPayment: {
      findMany: jest.fn(async ({ where }: any) =>
        data.payments
          .filter((p) => p.status === where.status && clinic(p.tenantId))
          .map((p) => ({ amount: p.amount, currency: p.currency })),
      ),
    },
  };
}

function build(
  data: Partial<{
    tenants: TenantRow[];
    subscriptions: SubscriptionRow[];
    payments: PaymentRow[];
  }>,
) {
  const prisma = fakePrisma({ tenants: [], subscriptions: [], payments: [], ...data });
  return new PlatformSummaryService(prisma as any);
}

describe('PlatformSummaryService', () => {
  it('counts active and suspended clinics without the platform tenant', async () => {
    const service = build({
      tenants: [
        tenant('a'),
        tenant('b'),
        tenant('c', { isActive: false }),
        tenant('platform', { isPlatform: true }),
        tenant('platform-off', { isPlatform: true, isActive: false }),
      ],
    });

    const summary = await service.getSummary(NOW);

    expect(summary.tenants).toEqual({ active: 2, suspended: 1 });
  });

  it('groups subscriptions by status and folds UNPAID, CANCELED and INCOMPLETE into blocked', async () => {
    const statuses = [
      'TRIALING',
      'TRIALING',
      'ACTIVE',
      'PAST_DUE',
      'UNPAID',
      'CANCELED',
      'CANCELED',
      'INCOMPLETE',
    ];
    const service = build({
      tenants: [
        ...statuses.map((_, i) => tenant(`t${i}`)),
        tenant('platform', { isPlatform: true }),
      ],
      subscriptions: [
        ...statuses.map((status, i) => subscription(`t${i}`, { status })),
        subscription('platform', { status: 'ACTIVE' }),
      ],
    });

    const summary = await service.getSummary(NOW);

    expect(summary.subscriptions).toEqual({ trialing: 2, active: 1, pastDue: 1, blocked: 4 });
  });

  it('sums pending payments', async () => {
    const service = build({
      tenants: [tenant('a'), tenant('b'), tenant('platform', { isPlatform: true })],
      payments: [
        { tenantId: 'a', status: 'PENDING', amount: 99, currency: 'USD' },
        { tenantId: 'b', status: 'PENDING', amount: 159, currency: 'USD' },
        { tenantId: 'a', status: 'CONFIRMED', amount: 500, currency: 'USD' },
        { tenantId: 'platform', status: 'PENDING', amount: 1000, currency: 'USD' },
      ],
    });

    const summary = await service.getSummary(NOW);

    expect(summary.pendingPayments).toEqual({ count: 2, amount: 258, currency: 'USD' });
  });

  it('lists trials ending within seven days, soonest first, and no expired ones', async () => {
    const service = build({
      tenants: [tenant('late'), tenant('soon'), tenant('expired'), tenant('far'), tenant('paid')],
      subscriptions: [
        subscription('late', { status: 'TRIALING', trialEndsAt: day(6) }),
        subscription('soon', { status: 'TRIALING', trialEndsAt: day(1) }),
        subscription('expired', { status: 'TRIALING', trialEndsAt: day(-1) }),
        subscription('far', { status: 'TRIALING', trialEndsAt: day(8) }),
        subscription('paid', { status: 'ACTIVE', trialEndsAt: day(2) }),
      ],
    });

    const summary = await service.getSummary(NOW);

    expect(summary.trialsEndingSoon).toEqual([
      { id: 'soon', name: 'Clinic soon', trialEndsAt: day(1) },
      { id: 'late', name: 'Clinic late', trialEndsAt: day(6) },
    ]);
  });

  it('lists the ten newest clinics', async () => {
    const tenants = Array.from({ length: 12 }, (_, i) =>
      tenant(`t${i}`, { createdAt: new Date(Date.UTC(2026, 8, i + 1)) }),
    );
    tenants.push(tenant('platform', { isPlatform: true, createdAt: new Date('2026-12-01') }));
    const service = build({
      tenants,
      subscriptions: [subscription('t11', { plan: { name: 'Clínica Pro' } })],
    });

    const summary = await service.getSummary(NOW);

    expect(summary.recentTenants).toHaveLength(10);
    expect(summary.recentTenants.map((t) => t.id)).toEqual([
      't11',
      't10',
      't9',
      't8',
      't7',
      't6',
      't5',
      't4',
      't3',
      't2',
    ]);
    expect(summary.recentTenants[0]).toEqual({
      id: 't11',
      name: 'Clinic t11',
      planName: 'Clínica Pro',
      createdAt: new Date(Date.UTC(2026, 8, 12)),
    });
    expect(summary.recentTenants[1].planName).toBeNull();
  });

  it('returns zeros and empty lists on an empty platform', async () => {
    const summary = await build({}).getSummary(NOW);

    expect(summary).toEqual({
      tenants: { active: 0, suspended: 0 },
      subscriptions: { trialing: 0, active: 0, pastDue: 0, blocked: 0 },
      pendingPayments: { count: 0, amount: 0, currency: 'USD' },
      trialsEndingSoon: [],
      recentTenants: [],
    });
  });
});
