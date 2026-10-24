import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, SubscriptionEventType, SubscriptionStatus } from '@prisma/client';
import { monthlyTotal } from '../plans/plan-values';
import { PrismaService } from '../prisma/prisma.service';
import { BILLING_RULES, addDays, addMonth } from './subscription-billing.rules';

export type LifecycleReport = {
  renewalsIssued: number;
  enteredGrace: number;
  blocked: number;
};

/**
 * Keeps subscriptions in step with time: the charge of each next period (the first one at the
 * end of a trial) and the states that follow an unpaid period. Every step claims its row with a
 * conditional update, so running twice, or on two instances at once, changes nothing the
 * second time.
 */
@Injectable()
export class SubscriptionLifecycleService {
  private readonly logger = new Logger(SubscriptionLifecycleService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron() {
    try {
      const report = await this.run();
      if (Object.values(report).some((count) => count > 0)) {
        this.logger.log(`Subscription lifecycle: ${JSON.stringify(report)}`);
      }
    } catch (error) {
      this.logger.error('Subscription lifecycle run failed', (error as Error).stack);
    }
  }

  async run(now: Date = new Date()): Promise<LifecycleReport> {
    const renewalsIssued = await this.issueRenewals(now);
    const enteredGrace = await this.enterGracePeriod(now);
    const blocked = await this.endGracePeriod(now);

    return { renewalsIssued, enteredGrace, blocked };
  }

  /**
   * One charge per tenant and period, at the price of the plan the clinic is on then: the unique
   * index absorbs repeated runs. A trial is charged its first month when it is about to end.
   */
  private async issueRenewals(now: Date): Promise<number> {
    const soon = addDays(now, BILLING_RULES.renewalNoticeDays);
    const renewing = await this.prisma.tenantSubscription.findMany({
      where: {
        OR: [
          { status: 'ACTIVE', currentPeriodEnd: { not: null, lte: soon } },
          { status: 'TRIALING', trialEndsAt: { not: null, lte: soon } },
        ],
      },
      include: { plan: { select: { id: true, name: true } } },
    });
    let issued = 0;

    for (const subscription of renewing) {
      const periodStart =
        subscription.status === 'TRIALING'
          ? subscription.trialEndsAt!
          : subscription.currentPeriodEnd!;
      const specialtyCount = await this.prisma.tenantSpecialty.count({
        where: { tenantId: subscription.tenantId },
      });
      const amount = monthlyTotal(subscription, specialtyCount);
      if (amount <= 0) continue;

      const result = await this.prisma.subscriptionPayment.createMany({
        data: [
          {
            tenantId: subscription.tenantId,
            kind: 'RENEWAL',
            amount: new Prisma.Decimal(amount),
            currency: subscription.currency,
            planId: subscription.plan.id,
            planName: subscription.plan.name,
            periodStart,
            periodEnd: addMonth(periodStart),
          },
        ],
        skipDuplicates: true,
      });
      issued += result.count;
    }

    return issued;
  }

  /** An ended trial or an unpaid period leaves the account read-only. */
  private async enterGracePeriod(now: Date): Promise<number> {
    const [expiredTrials, unpaidPeriods] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: { status: 'TRIALING', trialEndsAt: { lte: now } },
        select: { id: true, tenantId: true },
      }),
      this.prisma.tenantSubscription.findMany({
        where: {
          status: 'ACTIVE',
          basePrice: { gt: 0 },
          currentPeriodEnd: { not: null, lte: now },
        },
        select: { id: true, tenantId: true },
      }),
    ]);

    let moved = 0;
    for (const row of expiredTrials) {
      moved += await this.transition(row, 'TRIALING', 'PAST_DUE', 'TRIAL_ENDED');
    }
    for (const row of unpaidPeriods) {
      moved += await this.transition(row, 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD_ENTERED');
    }
    return moved;
  }

  private async endGracePeriod(now: Date): Promise<number> {
    const limit = addDays(now, -BILLING_RULES.graceDays);
    const overdue = await this.prisma.tenantSubscription.findMany({
      where: {
        status: 'PAST_DUE',
        OR: [
          // An ended trial has no paid period yet.
          { currentPeriodEnd: null, trialEndsAt: { not: null, lte: limit } },
          { currentPeriodEnd: { not: null, lte: limit } },
        ],
      },
      select: { id: true, tenantId: true },
    });

    let moved = 0;
    for (const row of overdue) {
      moved += await this.transition(row, 'PAST_DUE', 'UNPAID', 'GRACE_PERIOD_ENDED');
    }
    return moved;
  }

  /** Moves one subscription between states and records it, only if it is still in `from`. */
  private async transition(
    row: { id: string; tenantId: string },
    from: SubscriptionStatus,
    to: SubscriptionStatus,
    eventType: SubscriptionEventType,
  ): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tenantSubscription.updateMany({
        where: { id: row.id, status: from },
        data: { status: to },
      });
      if (claimed.count === 0) return 0;

      await tx.subscriptionEvent.create({
        data: { tenantId: row.tenantId, eventType, previousStatus: from, newStatus: to },
      });
      return 1;
    });
  }
}
