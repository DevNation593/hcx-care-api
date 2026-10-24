import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PlatformSummary {
  tenants: { active: number; suspended: number };
  /** blocked = UNPAID + CANCELED + INCOMPLETE. */
  subscriptions: { trialing: number; active: number; pastDue: number; blocked: number };
  pendingPayments: { count: number; amount: number; currency: string };
  trialsEndingSoon: { id: string; name: string; trialEndsAt: Date }[];
  recentTenants: { id: string; name: string; planName: string | null; createdAt: Date }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_WINDOW_DAYS = 7;
const RECENT_TENANTS = 10;
const DEFAULT_CURRENCY = 'USD';

/** Read-only dashboard figures. The platform tenant is excluded from every figure. */
@Injectable()
export class PlatformSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(now: Date = new Date()): Promise<PlatformSummary> {
    const trialLimit = new Date(now.getTime() + TRIAL_WINDOW_DAYS * DAY_MS);
    const clinics = { isPlatform: false };

    const [active, suspended, byStatus, pending, trials, recent] = await Promise.all([
      this.prisma.tenant.count({ where: { ...clinics, isActive: true } }),
      this.prisma.tenant.count({ where: { ...clinics, isActive: false } }),
      this.prisma.tenantSubscription.groupBy({
        by: ['status'],
        where: { tenant: clinics },
        _count: { _all: true },
      }),
      this.prisma.subscriptionPayment.findMany({
        where: { status: 'PENDING', tenant: clinics },
        select: { amount: true, currency: true },
      }),
      this.prisma.tenantSubscription.findMany({
        where: { status: 'TRIALING', tenant: clinics, trialEndsAt: { gte: now, lte: trialLimit } },
        orderBy: { trialEndsAt: 'asc' },
        select: { trialEndsAt: true, tenant: { select: { id: true, name: true } } },
      }),
      this.prisma.tenant.findMany({
        where: clinics,
        orderBy: { createdAt: 'desc' },
        take: RECENT_TENANTS,
        select: {
          id: true,
          name: true,
          createdAt: true,
          subscription: { select: { plan: { select: { name: true } } } },
        },
      }),
    ]);

    const count = (...statuses: string[]) =>
      byStatus
        .filter((row) => statuses.includes(row.status))
        .reduce((total, row) => total + row._count._all, 0);

    return {
      tenants: { active, suspended },
      subscriptions: {
        trialing: count('TRIALING'),
        active: count('ACTIVE'),
        pastDue: count('PAST_DUE'),
        blocked: count('UNPAID', 'CANCELED', 'INCOMPLETE'),
      },
      pendingPayments: {
        count: pending.length,
        amount: pending.reduce((total, payment) => total + Number(payment.amount), 0),
        currency: pending[0]?.currency ?? DEFAULT_CURRENCY,
      },
      trialsEndingSoon: trials.map((row) => ({
        id: row.tenant.id,
        name: row.tenant.name,
        trialEndsAt: row.trialEndsAt as Date,
      })),
      recentTenants: recent.map((tenant) => ({
        id: tenant.id,
        name: tenant.name,
        planName: tenant.subscription?.plan.name ?? null,
        createdAt: tenant.createdAt,
      })),
    };
  }
}
