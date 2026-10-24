import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleSource, Plan, Prisma, TenantType } from '@prisma/client';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { SECTION_CATALOG, SectionKey, validateSections } from '../common/sections/section-catalog';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlanDto, UpdatePlanDto } from '../plans/dto/plan.dto';
import { planModuleDefaults, subscriptionValuesFromPlan } from '../plans/plan-values';
import { PlatformAuditService } from './platform-audit.service';

export interface PlanView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  tenantType: TenantType;
  sortOrder: number;
  archivedAt: Date | null;
  basePrice: number;
  pricePerSeat: number;
  specialtyPrice: number;
  currency: string;
  seatsIncluded: number;
  maxActivePatients: number;
  storageGB: number;
  monthlyElectronicInvoicesLimit: number;
  includedSpecialties: number;
  trialDays: number;
  modules: SectionKey[];
  clinicsCount: number;
}

type PlanWithModules = Plan & { modules: { moduleKey: string }[] };

const PLAN_INCLUDE = {
  modules: { select: { moduleKey: true } },
  _count: { select: { subscriptions: true } },
} as const;

const notFound = () =>
  new NotFoundException({ code: 'PLAN_NOT_FOUND', message: 'Plan no encontrado' });

/**
 * Plans the platform administrator sells. Editing one updates every clinic on it right away:
 * price, limits and modules, except what was set apart for a clinic.
 */
@Injectable()
export class PlatformPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  async list(): Promise<PlanView[]> {
    const plans = await this.prisma.plan.findMany({
      include: PLAN_INCLUDE,
      orderBy: [{ tenantType: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    });
    return plans.map(toView);
  }

  async findOne(id: string): Promise<PlanView> {
    const plan = await this.prisma.plan.findUnique({ where: { id }, include: PLAN_INCLUDE });
    if (!plan) throw notFound();
    return toView(plan);
  }

  async create(dto: CreatePlanDto, actor: AuthUser): Promise<PlanView> {
    const modules = validateSections(dto.modules);
    const { modules: _modules, ...fields } = dto;
    try {
      const plan = await this.prisma.$transaction(async (tx) => {
        const created = await tx.plan.create({
          data: { ...fields, modules: { create: modules.map((moduleKey) => ({ moduleKey })) } },
          include: PLAN_INCLUDE,
        });
        await this.audit.record(
          {
            tenantId: actor.tenantId,
            actorId: actor.userId,
            entity: 'PLAN',
            entityId: created.id,
            changes: { before: null, after: snapshot(created) },
          },
          tx,
        );
        return created;
      });
      return toView(plan);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException({
          statusCode: 409,
          code: 'PLAN_CODE_TAKEN',
          message: 'Ya existe un plan con ese código.',
        });
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdatePlanDto, actor: AuthUser): Promise<PlanView> {
    const modules = dto.modules ? validateSections(dto.modules) : undefined;
    const { modules: _modules, ...fields } = dto;
    const plan = await this.prisma.$transaction(
      async (tx) => {
        const before = await tx.plan.findUnique({ where: { id }, include: PLAN_INCLUDE });
        if (!before) throw notFound();
        if (
          fields.tenantType &&
          fields.tenantType !== before.tenantType &&
          before._count.subscriptions > 0
        ) {
          throw new ConflictException({
            statusCode: 409,
            code: 'PLAN_IN_USE',
            message: 'No se puede cambiar el tipo de un plan que tienen consultorios.',
          });
        }

        await tx.plan.update({ where: { id }, data: fields });
        if (modules) {
          await tx.planModule.deleteMany({ where: { planId: id } });
          await tx.planModule.createMany({
            data: modules.map((moduleKey) => ({ planId: id, moduleKey })),
          });
        }
        const after = await tx.plan.findUniqueOrThrow({ where: { id }, include: PLAN_INCLUDE });
        await this.propagate(tx, after);
        await this.audit.record(
          {
            tenantId: actor.tenantId,
            actorId: actor.userId,
            entity: 'PLAN',
            entityId: id,
            changes: { before: snapshot(before), after: snapshot(after) },
          },
          tx,
        );
        return after;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 },
    );
    return toView(plan);
  }

  /** An archived plan keeps its clinics but cannot be given to new ones. */
  async setArchived(id: string, archived: boolean, actor: AuthUser): Promise<PlanView> {
    const plan = await this.prisma.$transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { id }, select: { archivedAt: true } });
      if (!before) throw notFound();
      const updated = await tx.plan.update({
        where: { id },
        data: { archivedAt: archived ? (before.archivedAt ?? new Date()) : null },
        include: PLAN_INCLUDE,
      });
      await this.audit.record(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          entity: 'PLAN',
          entityId: id,
          changes: {
            before: { archivedAt: before.archivedAt },
            after: { archivedAt: updated.archivedAt },
          },
        },
        tx,
      );
      return updated;
    });
    return toView(plan);
  }

  /** A plan that can be given to a clinic of this type: it exists and is not archived. */
  async findAssignable(
    client: Pick<Prisma.TransactionClient, 'plan'>,
    planId: string,
    tenantType: TenantType,
  ): Promise<PlanWithModules> {
    const plan = await client.plan.findUnique({
      where: { id: planId },
      include: { modules: { select: { moduleKey: true } } },
    });
    if (!plan) throw notFound();
    if (plan.archivedAt) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PLAN_ARCHIVED',
        message: 'El plan está archivado y no se puede asignar.',
      });
    }
    if (plan.tenantType !== tenantType) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PLAN_TYPE_MISMATCH',
        message: 'El plan no corresponde al tipo de consultorio.',
      });
    }
    return plan;
  }

  /**
   * Puts a clinic on a plan: its price, limits and modules become the plan's. The clinic's
   * overrides are dropped; status and billing period belong to the caller.
   */
  async assign(tx: Prisma.TransactionClient, tenantId: string, plan: PlanWithModules) {
    await tx.tenantSubscription.update({
      where: { tenantId },
      data: { planId: plan.id, overriddenFields: [], ...subscriptionValuesFromPlan(plan) },
    });
    await this.syncModules(tx, tenantId, plan, { resetOverrides: true });
  }

  /**
   * Sets the clinic's module rows to `enabledKeys`. A row matching what the plan gives follows
   * the plan from now on; one that differs becomes an override that plan edits leave alone.
   */
  async setTenantModules(tx: Prisma.TransactionClient, tenantId: string, enabledKeys: Set<string>) {
    const subscription = await tx.tenantSubscription.findUniqueOrThrow({
      where: { tenantId },
      select: { plan: { include: { modules: { select: { moduleKey: true } } } } },
    });
    const defaults = await this.moduleDefaults(tx, tenantId, subscription.plan);
    for (const { key } of SECTION_CATALOG) {
      const enabled = enabledKeys.has(key);
      const source = enabled === defaults.has(key) ? ModuleSource.PLAN : ModuleSource.OVERRIDE;
      await tx.tenantModule.upsert({
        where: { tenantId_moduleKey: { tenantId, moduleKey: key } },
        update: { enabled, source },
        create: { tenantId, moduleKey: key, enabled, source },
      });
    }
  }

  /** Every clinic on the plan takes its new values, except the ones overridden for it. */
  private async propagate(tx: Prisma.TransactionClient, plan: PlanWithModules) {
    const subscriptions = await tx.tenantSubscription.findMany({
      where: { planId: plan.id },
      select: { tenantId: true, overriddenFields: true },
    });
    for (const { tenantId, overriddenFields } of subscriptions) {
      await tx.tenantSubscription.update({
        where: { tenantId },
        data: subscriptionValuesFromPlan(plan, overriddenFields),
      });
      await this.syncModules(tx, tenantId, plan, { resetOverrides: false });
    }
  }

  private async syncModules(
    tx: Prisma.TransactionClient,
    tenantId: string,
    plan: PlanWithModules,
    { resetOverrides }: { resetOverrides: boolean },
  ) {
    const defaults = await this.moduleDefaults(tx, tenantId, plan);
    const rows = await tx.tenantModule.findMany({
      where: { tenantId, moduleKey: { startsWith: 'core.' } },
      select: { moduleKey: true, source: true },
    });
    const overridden = new Set(
      rows.filter((row) => row.source === ModuleSource.OVERRIDE).map((row) => row.moduleKey),
    );
    for (const { key } of SECTION_CATALOG) {
      if (!resetOverrides && overridden.has(key)) continue;
      const enabled = defaults.has(key);
      await tx.tenantModule.upsert({
        where: { tenantId_moduleKey: { tenantId, moduleKey: key } },
        update: { enabled, source: ModuleSource.PLAN },
        create: { tenantId, moduleKey: key, enabled, source: ModuleSource.PLAN },
      });
    }
  }

  private async moduleDefaults(
    tx: Prisma.TransactionClient,
    tenantId: string,
    plan: PlanWithModules,
  ): Promise<Set<SectionKey>> {
    const specialties = await tx.tenantSpecialty.findMany({
      where: { tenantId },
      select: { specialty: { select: { code: true } } },
    });
    return planModuleDefaults(
      plan.modules.map(({ moduleKey }) => moduleKey),
      specialties.map(({ specialty }) => specialty.code),
    );
  }
}

function toView(plan: PlanWithModules & { _count: { subscriptions: number } }): PlanView {
  const keys = new Set(plan.modules.map(({ moduleKey }) => moduleKey));
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    tenantType: plan.tenantType,
    sortOrder: plan.sortOrder,
    archivedAt: plan.archivedAt,
    basePrice: Number(plan.basePrice),
    pricePerSeat: Number(plan.pricePerSeat),
    specialtyPrice: Number(plan.specialtyPrice),
    currency: plan.currency,
    seatsIncluded: plan.seatsIncluded,
    maxActivePatients: plan.maxActivePatients,
    storageGB: plan.storageGB,
    monthlyElectronicInvoicesLimit: plan.monthlyElectronicInvoicesLimit,
    includedSpecialties: plan.includedSpecialties,
    trialDays: plan.trialDays,
    // Catalog order, so the panel and the audit read the same way every time.
    modules: SECTION_CATALOG.map(({ key }) => key).filter((key) => keys.has(key)),
    clinicsCount: plan._count.subscriptions,
  };
}

function snapshot(plan: PlanWithModules & { _count: { subscriptions: number } }) {
  const { clinicsCount: _count, ...view } = toView(plan);
  return view;
}
