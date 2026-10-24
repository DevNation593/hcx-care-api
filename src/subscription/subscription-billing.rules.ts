import { TenantSubscription } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

export const BILLING_RULES = {
  /** The renewal charge (or the first one, at the end of a trial) is issued this many days before. */
  renewalNoticeDays: 7,
  /** Read-only days after an unpaid period or trial ends, before access is blocked. */
  graceDays: 7,
} as const;

export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

/** Same day next month, clamped to the last day when that month is shorter (Jan 31 -> Feb 28). */
export function addMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  if (next.getUTCDate() !== date.getUTCDate()) next.setUTCDate(0);
  return next;
}

type PeriodFields = Pick<TenantSubscription, 'status' | 'currentPeriodEnd'>;

/** A paid period that has not ended yet: a plan change inside it keeps its dates. */
export function hasRunningPaidPeriod(subscription: PeriodFields, now: Date): boolean {
  return (
    subscription.status === 'ACTIVE' &&
    !!subscription.currentPeriodEnd &&
    subscription.currentPeriodEnd > now
  );
}
