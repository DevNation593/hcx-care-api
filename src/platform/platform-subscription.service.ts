import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, SubscriptionEventType, SubscriptionStatus } from '@prisma/client';
import {
  PLAN_VALUE_FIELDS,
  PlanValueData,
  PlanValueField,
  isPlanValueField,
  subscriptionValuesFromPlan,
} from '../plans/plan-values';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import {
  addDays,
  addMonth,
  hasRunningPaidPeriod,
} from '../subscription/subscription-billing.rules';
import { ChangePlanDto, SetPlanOverridesDto } from './dto/change-plan.dto';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformPlansService } from './platform-plans.service';
import { PlatformTenantDetail, PlatformTenantsService } from './platform-tenants.service';

const MONEY_FIELDS: readonly PlanValueField[] = ['basePrice', 'pricePerSeat', 'specialtyPrice'];

@Injectable()
export class PlatformSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: PlatformTenantsService,
    private readonly plans: PlatformPlansService,
    private readonly audit: PlatformAuditService,
  ) {}

  /**
   * Moves a clinic to another plan right away, with no payment: price, limits and modules become
   * the new plan's and the clinic's overrides are dropped. With trial days the clinic tries the
   * plan for free; otherwise it pays from today, or keeps a paid period that is still running.
   * A limit below current usage deletes nothing: the clinic just cannot add more.
   */
  async changePlan(
    tenantId: string,
    dto: ChangePlanDto,
    actorId: string,
  ): Promise<PlatformTenantDetail> {
    // Answers 404 for a missing or platform tenant before opening a transaction.
    const { tenant } = await this.tenants.findOne(tenantId);

    await runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const plan = await this.plans.findAssignable(tx, dto.planId, tenant.tenantType);
      const subscription = await tx.tenantSubscription.findUniqueOrThrow({
        where: { tenantId },
        include: { plan: { select: { code: true, basePrice: true } } },
      });
      if (subscription.planId === plan.id && !dto.trialDays) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'PLAN_UNCHANGED',
          message: 'El consultorio ya tiene ese plan.',
        });
      }
      const now = new Date();
      let period: {
        status: SubscriptionStatus;
        trialEndsAt?: Date | null;
        currentPeriodStart?: Date;
        currentPeriodEnd?: Date | null;
      };
      if (dto.trialDays) {
        period = {
          status: SubscriptionStatus.TRIALING,
          trialEndsAt: addDays(now, dto.trialDays),
          currentPeriodStart: now,
          currentPeriodEnd: null,
        };
      } else if (hasRunningPaidPeriod(subscription, now)) {
        period = { status: SubscriptionStatus.ACTIVE };
      } else {
        // Coming from a trial or a lapsed period, the paid month starts today.
        period = {
          status: SubscriptionStatus.ACTIVE,
          trialEndsAt: null,
          currentPeriodStart: now,
          currentPeriodEnd: addMonth(now),
        };
      }

      await this.plans.assign(tx, tenantId, plan);
      await tx.tenantSubscription.update({ where: { tenantId }, data: period });

      const eventType = dto.trialDays
        ? SubscriptionEventType.SUBSCRIPTION_ACTIVATED
        : Number(plan.basePrice) >= Number(subscription.plan.basePrice)
          ? SubscriptionEventType.PLAN_UPGRADED
          : SubscriptionEventType.PLAN_DOWNGRADED;
      await tx.subscriptionEvent.create({
        data: {
          tenantId,
          eventType,
          previousPlan: subscription.plan.code,
          newPlan: plan.code,
          previousStatus: subscription.status,
          newStatus: period.status,
          reason: dto.reason,
          metadata: {
            source: 'PLATFORM_PANEL',
            trialDays: dto.trialDays ?? null,
            droppedOverrides: subscription.overriddenFields,
          },
          triggeredByUserId: actorId,
        },
      });
    });

    return this.tenants.findOne(tenantId);
  }

  /**
   * Sets price and limit values for one clinic apart from its plan, or puts them back on the
   * plan. An overridden value survives plan edits until it is reset.
   */
  async setOverrides(
    tenantId: string,
    dto: SetPlanOverridesDto,
    actorId: string,
  ): Promise<PlatformTenantDetail> {
    const values = parseOverrideValues(dto.values);
    const reset = (dto.reset ?? []).filter(isPlanValueField);
    const both = reset.filter((field) => field in values);
    if (both.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'OVERRIDE_CONFLICT',
        message: 'Un mismo valor no puede fijarse y restablecerse a la vez.',
        fields: both,
      });
    }
    if (Object.keys(values).length === 0 && reset.length === 0) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'OVERRIDE_EMPTY',
        message: 'Indica al menos un valor para fijar o restablecer.',
      });
    }
    await this.tenants.findOne(tenantId);

    await runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const subscription = await tx.tenantSubscription.findUniqueOrThrow({
        where: { tenantId },
        include: { plan: true },
      });
      const fromPlan = subscriptionValuesFromPlan(
        subscription.plan,
        PLAN_VALUE_FIELD_LIST.filter((field) => !reset.includes(field)),
      );
      const next = { ...values, ...fromPlan };

      const overridden = new Set(subscription.overriddenFields);
      for (const field of Object.keys(values)) overridden.add(field);
      for (const field of reset) overridden.delete(field);
      const changed = [...Object.keys(values), ...reset] as PlanValueField[];

      await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          ...next,
          overriddenFields: PLAN_VALUE_FIELD_LIST.filter((field) => overridden.has(field)),
        },
      });
      await this.audit.record(
        {
          tenantId,
          actorId,
          entity: 'TENANT',
          entityId: tenantId,
          reason: dto.reason,
          changes: {
            before: Object.fromEntries(
              changed.map((field) => [field, plainValue(subscription[field])]),
            ),
            after: Object.fromEntries(
              changed.map((field) => [field, plainValue(next[field as keyof typeof next])]),
            ),
          },
        },
        tx,
      );
    });

    return this.tenants.findOne(tenantId);
  }
}

const PLAN_VALUE_FIELD_LIST = Object.keys(PLAN_VALUE_FIELDS) as PlanValueField[];

function plainValue(value: unknown) {
  return value instanceof Prisma.Decimal ? Number(value) : value;
}

/** Validates each overridden value: known field, money with 2 decimals, whole limits, currency code. */
function parseOverrideValues(raw: Record<string, number | string>) {
  const values: Record<string, Prisma.Decimal | number | string> = {};
  for (const [field, value] of Object.entries(raw ?? {})) {
    if (!isPlanValueField(field)) {
      throw invalidOverride(field, 'No es un valor del plan.');
    }
    if (field === 'currency') {
      if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
        throw invalidOverride(field, 'Usa un código de moneda de 3 letras, como USD.');
      }
      values[field] = value;
    } else if (MONEY_FIELDS.includes(field)) {
      if (typeof value !== 'number' || value < 0 || Math.round(value * 100) !== value * 100) {
        throw invalidOverride(field, 'Usa un monto de 0 o más, con hasta 2 decimales.');
      }
      values[field] = new Prisma.Decimal(value);
    } else {
      const minimum = field === 'monthlyElectronicInvoicesLimit' ? 0 : 1;
      if (!Number.isInteger(value) || (value as number) < minimum) {
        throw invalidOverride(field, `Usa un número entero de ${minimum} o más.`);
      }
      values[field] = value;
    }
  }
  return values as PlanValueData;
}

function invalidOverride(field: string, message: string) {
  return new BadRequestException({ statusCode: 400, code: 'OVERRIDE_INVALID', field, message });
}
