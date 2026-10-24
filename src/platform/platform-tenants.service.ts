import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleSource, Prisma, SubscriptionStatus, TenantType, UserRole } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import {
  SECTION_CATALOG,
  SectionDefinition,
  SectionKey,
  validateSections,
} from '../common/sections/section-catalog';
import { PrismaService } from '../prisma/prisma.service';
import { AESTHETIC_SPECIALTY_CODES } from '../clinical-modules/clinical-module-registry';
import {
  SpecialtyCatalogService,
  normalizeSpecialtyCodes,
} from '../specialties/specialty-catalog.service';
import { TenantSpecialtiesService } from '../specialties/tenant-specialties.service';
import { MAIN_BRANCH_NAME } from '../branches/branches.service';
import {
  PlanValueField,
  monthlyTotal,
  planModuleDefaults,
  subscriptionValuesFromPlan,
} from '../plans/plan-values';
import { addDays, addMonth } from '../subscription/subscription-billing.rules';
import { CreatePlatformTenantDto } from './dto/create-platform-tenant.dto';
import { ListPlatformTenantsQueryDto } from './dto/platform-tenant.dto';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformPlansService } from './platform-plans.service';

export interface PlatformTenantRow {
  id: string;
  name: string;
  tenantType: TenantType;
  isActive: boolean;
  createdAt: Date;
  master: { firstName: string; lastName: string; email: string } | null;
  plan: { id: string; code: string; name: string } | null;
  status: SubscriptionStatus | null;
  seatsPsychologistsUsed: number;
  seatsPsychologistsMax: number;
  activePatientsCount: number;
  maxActivePatients: number;
}

const MAX_PAGE_SIZE = 100;

export interface PlatformTenantDetail {
  tenant: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    address: string | null;
    tenantType: TenantType;
    isActive: boolean;
    createdAt: Date;
  };
  master: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    mustChangePassword: boolean;
  } | null;
  subscription: {
    plan: { id: string; code: string; name: string };
    status: SubscriptionStatus;
    trialEndsAt: Date | null;
    currentPeriodStart: Date;
    currentPeriodEnd: Date | null;
    basePrice: number;
    pricePerSeat: number;
    specialtyPrice: number;
    currency: string;
    seatsPsychologistsMax: number;
    maxActivePatients: number;
    storageGB: number;
    monthlyElectronicInvoicesLimit: number;
    includedSpecialties: number;
    /** Values set for this clinic apart from its plan. */
    overriddenFields: PlanValueField[];
    /** The plan price plus the specialties beyond the included ones. */
    monthlyTotal: number;
  };
  usage: {
    seatsPsychologistsUsed: number;
    activePatientsCount: number;
    monthlyNotificationsSent: number;
  };
  specialties: { id: string; code: string; name: string }[];
  sections: { key: SectionKey; name: string; enabled: boolean; source: ModuleSource }[];
  modules: { key: string; enabled: boolean }[];
}

@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly catalog: SpecialtyCatalogService,
    private readonly tenantSpecialties: TenantSpecialtiesService,
    private readonly audit: PlatformAuditService,
    private readonly plans: PlatformPlansService,
  ) {}

  async create(dto: CreatePlatformTenantDto, actorId: string): Promise<PlatformTenantDetail> {
    const specialtyCodes = normalizeSpecialtyCodes(dto.specialtyCodes);
    if (specialtyCodes.length === 0) {
      throw new BadRequestException({
        code: 'SPECIALTY_SELECTION_REQUIRED',
        message: 'Selecciona al menos una especialidad.',
      });
    }
    if (specialtyCodes.length !== dto.specialtyCodes.length) {
      throw new BadRequestException({
        code: 'SPECIALTY_SELECTION_DUPLICATE',
        message: 'Cada especialidad debe aparecer una sola vez.',
      });
    }
    // Answers 404/409 for an unknown, archived or mismatched plan before hashing the password.
    const chosenPlan = await this.plans.findAssignable(this.prisma, dto.planId, dto.tenantType);
    const enabledSections = new Set<string>(
      dto.sections
        ? validateSections(dto.sections)
        : planModuleDefaults(
            chosenPlan.modules.map(({ moduleKey }) => moduleKey),
            specialtyCodes,
          ),
    );
    const trialDays = dto.trialDays ?? chosenPlan.trialDays;

    const masterEmail = dto.masterEmail.trim().toLowerCase();
    const password = await this.auth.hashPassword(dto.temporaryPassword);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            // User.email is unique per tenant only. Serialize creations for the same normalized
            // email before checking it globally (this also covers platform ADMIN accounts).
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${masterEmail}))`;
            const existing = await tx.user.findFirst({
              where: { email: { equals: masterEmail, mode: 'insensitive' } },
              select: { id: true },
            });
            if (existing) throw new ConflictException('El correo electrónico ya está en uso');

            const tenant = await tx.tenant.create({
              data: {
                name: dto.name.trim(),
                email: dto.email.trim().toLowerCase(),
                phone: dto.phone?.trim(),
                address: dto.address?.trim(),
                tenantType: dto.tenantType,
                onboardingCompleted: true,
              },
              select: { id: true },
            });
            await this.prisma.applyRlsContext(tx, { tenantId: tenant.id });
            await tx.branch.create({
              data: {
                tenantId: tenant.id,
                name: MAIN_BRANCH_NAME,
                address: dto.address?.trim() || null,
                phone: dto.phone?.trim() || null,
                isMain: true,
              },
            });
            await tx.tenantSettings.create({
              data: {
                tenantId: tenant.id,
                timezone: dto.timezone.trim(),
                locale: dto.locale.trim(),
              },
            });

            const plan = await this.plans.findAssignable(tx, dto.planId, dto.tenantType);
            const isTrial = trialDays > 0;
            const now = new Date();
            const subscription = await tx.tenantSubscription.create({
              data: {
                tenantId: tenant.id,
                planId: plan.id,
                status: isTrial ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE,
                trialEndsAt: isTrial ? addDays(now, trialDays) : null,
                currentPeriodStart: now,
                currentPeriodEnd: isTrial ? null : addMonth(now),
                seatsPsychologistsUsed: 0,
                ...subscriptionValuesFromPlan(plan),
              },
            });
            if (!isTrial) {
              await tx.subscriptionEvent.create({
                data: {
                  tenantId: tenant.id,
                  eventType: 'SUBSCRIPTION_ACTIVATED',
                  newPlan: plan.code,
                  newStatus: SubscriptionStatus.ACTIVE,
                  triggeredByUserId: actorId,
                },
              });
            }

            const specialties = await this.catalog.resolveActiveCodes(specialtyCodes, tx);
            await tx.user.create({
              data: {
                tenantId: tenant.id,
                email: masterEmail,
                password,
                firstName: dto.masterFirstName.trim(),
                lastName: dto.masterLastName.trim(),
                role: UserRole.MASTER,
                isActive: true,
                emailVerified: true,
                activatedAt: new Date(),
                mustChangePassword: true,
                managedByProvider: false,
              },
              select: { id: true },
            });
            await this.tenantSpecialties.applySelection(tx, {
              tenantId: tenant.id,
              subscription,
              specialties,
            });
            // After the specialties: health-only submodules depend on them.
            await this.plans.setTenantModules(tx, tenant.id, enabledSections);
            return this.loadDetail(tx, tenant.id);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if ((error as { code?: string }).code === 'P2034' && attempt < 2) continue;
        if ((error as { code?: string }).code === 'P2002') {
          const target = (error as { meta?: { target?: string[] | string } }).meta?.target;
          const fields = Array.isArray(target) ? target : [target];
          if (fields.some((field) => field?.toLowerCase().includes('email'))) {
            throw new ConflictException('El correo electrónico ya está en uso');
          }
          if (fields.some((field) => field?.toLowerCase().includes('slug'))) {
            throw new ConflictException('El identificador del consultorio ya está en uso');
          }
        }
        throw error;
      }
    }
  }

  async list(
    query: ListPlatformTenantsQueryDto,
  ): Promise<{ items: PlatformTenantRow[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Math.trunc(query.page) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(query.pageSize) || 20));
    const where: Prisma.TenantWhereInput = { isPlatform: false };
    if (query.isActive !== undefined) where.isActive = query.isActive;
    if (query.planId || query.status) {
      where.subscription = {
        is: {
          ...(query.planId ? { planId: query.planId } : {}),
          ...(query.status ? { status: query.status } : {}),
        },
      };
    }
    const search = query.search?.trim();
    if (search) {
      const term = { contains: search, mode: 'insensitive' as const };
      where.OR = [
        { name: term },
        { email: term },
        { users: { some: { role: UserRole.MASTER, firstName: term } } },
        { users: { some: { role: UserRole.MASTER, lastName: term } } },
        { users: { some: { role: UserRole.MASTER, email: term } } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          tenantType: true,
          isActive: true,
          createdAt: true,
          subscription: {
            select: {
              plan: { select: { id: true, code: true, name: true } },
              status: true,
              seatsPsychologistsUsed: true,
              seatsPsychologistsMax: true,
              activePatientsCount: true,
              maxActivePatients: true,
            },
          },
          users: {
            where: { role: UserRole.MASTER },
            take: 1,
            select: { firstName: true, lastName: true, email: true },
          },
        },
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        tenantType: row.tenantType,
        isActive: row.isActive,
        createdAt: row.createdAt,
        master: row.users[0] ?? null,
        plan: row.subscription?.plan ?? null,
        status: row.subscription?.status ?? null,
        seatsPsychologistsUsed: row.subscription?.seatsPsychologistsUsed ?? 0,
        seatsPsychologistsMax: row.subscription?.seatsPsychologistsMax ?? 0,
        activePatientsCount: row.subscription?.activePatientsCount ?? 0,
        maxActivePatients: row.subscription?.maxActivePatients ?? 0,
      })),
      total,
      page,
      pageSize,
    };
  }

  async updateAccount(
    tenantId: string,
    dto: { name?: string; email?: string; phone?: string; address?: string },
    actorId: string,
  ): Promise<PlatformTenantDetail> {
    const fields = ['name', 'email', 'phone', 'address'] as const;
    const data: Partial<Record<(typeof fields)[number], string>> = {};
    for (const field of fields) {
      const value = dto[field];
      if (value !== undefined) {
        data[field] = field === 'email' ? value.trim().toLowerCase() : value.trim();
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.tenant.findFirst({
        where: { id: tenantId, isPlatform: false },
        select: { name: true, email: true, phone: true, address: true },
      });
      if (!current) throw new NotFoundException('Consultorio no encontrado');
      const keys = (Object.keys(data) as (typeof fields)[number][]).filter(
        (key) => current[key] !== data[key],
      );
      if (keys.length > 0) {
        await tx.tenant.update({ where: { id: tenantId }, data });
        await this.audit.record(
          {
            tenantId,
            actorId,
            entity: 'TENANT',
            entityId: tenantId,
            changes: {
              before: Object.fromEntries(keys.map((key) => [key, current[key]])),
              after: Object.fromEntries(keys.map((key) => [key, data[key]])),
            },
          },
          tx,
        );
      }
      return this.loadDetail(tx, tenantId);
    });
  }

  suspend(tenantId: string, reason: string, actorId: string): Promise<PlatformTenantDetail> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.tenant.updateMany({
        where: { id: tenantId, isPlatform: false, isActive: true },
        data: { isActive: false },
      });
      // Count 0 means unknown, platform or already suspended: loadDetail answers 404 or the current state.
      if (count > 0) {
        await tx.refreshToken.updateMany({
          where: { user: { tenantId }, isRevoked: false },
          data: { isRevoked: true },
        });
        await this.audit.record(
          {
            tenantId,
            actorId,
            entity: 'TENANT',
            entityId: tenantId,
            reason,
            changes: { before: { isActive: true }, after: { isActive: false } },
          },
          tx,
        );
      }
      return this.loadDetail(tx, tenantId);
    });
  }

  reactivate(tenantId: string, actorId: string): Promise<PlatformTenantDetail> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.tenant.updateMany({
        where: { id: tenantId, isPlatform: false, isActive: false },
        data: { isActive: true },
      });
      if (count > 0) {
        await this.audit.record(
          {
            tenantId,
            actorId,
            entity: 'TENANT',
            entityId: tenantId,
            changes: { before: { isActive: false }, after: { isActive: true } },
          },
          tx,
        );
      }
      return this.loadDetail(tx, tenantId);
    });
  }

  async setSections(
    tenantId: string,
    sections: string[],
    actorId: string,
  ): Promise<PlatformTenantDetail> {
    const enabled = new Set<string>(validateSections(sections));
    const inCatalogOrder = (keys: Set<string>) =>
      SECTION_CATALOG.map(({ key }) => key).filter((key) => keys.has(key));
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId, isPlatform: false },
        select: { id: true },
      });
      if (!tenant) throw new NotFoundException('Consultorio no encontrado');
      const previous = await tx.tenantModule.findMany({
        where: { tenantId, moduleKey: { startsWith: 'core.' } },
        select: { moduleKey: true, enabled: true },
      });
      await this.plans.setTenantModules(tx, tenantId, enabled);
      await this.audit.record(
        {
          tenantId,
          actorId,
          entity: 'TENANT',
          entityId: tenantId,
          changes: {
            before: {
              sections: inCatalogOrder(
                new Set(previous.filter((m) => m.enabled).map((m) => m.moduleKey)),
              ),
            },
            after: { sections: inCatalogOrder(enabled) },
          },
        },
        tx,
      );
      return this.loadDetail(tx, tenantId);
    });
  }

  async resetMasterPassword(
    tenantId: string,
    temporaryPassword: string,
    actorId: string,
  ): Promise<void> {
    // Fail with 404 before spending a bcrypt hash on a missing or platform tenant.
    const target = await this.prisma.tenant.findFirst({
      where: { id: tenantId, isPlatform: false },
      select: { users: { where: { role: UserRole.MASTER }, take: 1, select: { id: true } } },
    });
    if (!target) throw new NotFoundException('Consultorio no encontrado');
    if (!target.users[0]) throw new NotFoundException('El consultorio no tiene titular');
    // The password is hashed exactly as typed; it never reaches logs or the audit row.
    const password = await this.auth.hashPassword(temporaryPassword);
    await this.prisma.$transaction(async (tx) => {
      const master = await tx.user.findFirst({
        where: { tenantId, role: UserRole.MASTER },
        select: { id: true, mustChangePassword: true },
      });
      if (!master) throw new NotFoundException('El consultorio no tiene titular');
      await tx.user.update({
        where: { id: master.id },
        data: { password, mustChangePassword: true },
      });
      await tx.refreshToken.updateMany({
        where: { userId: master.id, isRevoked: false },
        data: { isRevoked: true },
      });
      await this.audit.record(
        {
          tenantId,
          actorId,
          entity: 'USER',
          entityId: master.id,
          changes: {
            before: { mustChangePassword: master.mustChangePassword },
            after: { mustChangePassword: true },
          },
        },
        tx,
      );
    });
  }

  findOne(tenantId: string): Promise<PlatformTenantDetail> {
    return this.loadDetail(this.prisma, tenantId);
  }

  /** The module catalog; each plan says which keys it turns on (GET platform/plans). */
  getSectionCatalog(): {
    sections: SectionDefinition[];
    /** Specialties whose clinics start without the health-only sections. */
    nonHealthSpecialtyCodes: string[];
  } {
    return {
      sections: SECTION_CATALOG.map((section) => ({ ...section })),
      nonHealthSpecialtyCodes: [...AESTHETIC_SPECIALTY_CODES],
    };
  }

  private async loadDetail(
    client: Pick<Prisma.TransactionClient, 'tenant'>,
    tenantId: string,
  ): Promise<PlatformTenantDetail> {
    const row = await client.tenant.findFirst({
      where: { id: tenantId, isPlatform: false },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        address: true,
        tenantType: true,
        isActive: true,
        createdAt: true,
        subscription: {
          include: {
            plan: { select: { id: true, code: true, name: true } },
            _count: { select: { specialties: true } },
          },
        },
        users: {
          where: { role: UserRole.MASTER },
          take: 1,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            mustChangePassword: true,
          },
        },
        specialties: {
          select: { specialty: { select: { id: true, code: true, name: true } } },
        },
        enabledModules: { select: { moduleKey: true, enabled: true, source: true } },
      },
    });
    if (!row || !row.subscription) throw new NotFoundException('Consultorio no encontrado');

    const { subscription } = row;
    const moduleByKey = new Map(row.enabledModules.map((m) => [m.moduleKey, m]));
    return {
      tenant: {
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        address: row.address,
        tenantType: row.tenantType,
        isActive: row.isActive,
        createdAt: row.createdAt,
      },
      master: row.users[0] ?? null,
      subscription: {
        plan: subscription.plan,
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        basePrice: Number(subscription.basePrice),
        pricePerSeat: Number(subscription.pricePerSeat),
        specialtyPrice: Number(subscription.specialtyPrice),
        currency: subscription.currency,
        seatsPsychologistsMax: subscription.seatsPsychologistsMax,
        maxActivePatients: subscription.maxActivePatients,
        storageGB: subscription.storageGB,
        monthlyElectronicInvoicesLimit: subscription.monthlyElectronicInvoicesLimit,
        includedSpecialties: subscription.includedSpecialties,
        overriddenFields: subscription.overriddenFields as PlanValueField[],
        monthlyTotal: monthlyTotal(subscription, subscription._count.specialties),
      },
      usage: {
        seatsPsychologistsUsed: subscription.seatsPsychologistsUsed,
        activePatientsCount: subscription.activePatientsCount,
        monthlyNotificationsSent: subscription.monthlyNotificationsSent,
      },
      specialties: row.specialties.map(({ specialty }) => specialty),
      sections: SECTION_CATALOG.map(({ key, name }) => ({
        key,
        name,
        enabled: moduleByKey.get(key)?.enabled === true,
        source: moduleByKey.get(key)?.source ?? ModuleSource.PLAN,
      })),
      modules: row.enabledModules
        .filter(({ moduleKey }) => !moduleKey.startsWith('core.'))
        .map(({ moduleKey, enabled }) => ({ key: moduleKey, enabled })),
    };
  }
}
