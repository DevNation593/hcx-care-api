import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TenantSubscription, TenantType, UserRole } from '@prisma/client';
import { monthlyTotal } from '../plans/plan-values';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { SpecialtyCatalogService } from './specialty-catalog.service';

type CatalogSpecialty = Awaited<ReturnType<SpecialtyCatalogService['resolveActiveCodes']>>[number];

export type SpecialtySelectionResult = {
  tenantId: string;
  specialties: CatalogSpecialty[];
  modules: Array<{ moduleKey: string; enabled: boolean }>;
  pricing: SpecialtyPricing;
  /** Set when the master of a personal practice lost their specialty and moved to another. */
  masterSpecialtyChange?: { userId: string; fromSpecialtyId: string; toSpecialtyId: string };
};

/** What the clinic pays a month with this selection; basePrice itself never changes here. */
export type SpecialtyPricing = {
  basePlanPrice: number;
  specialtyAddonsPrice: number;
  totalMonthly: number;
  includedSpecialties: number;
  selectedSpecialties: number;
  billableSpecialties: number;
  specialtyUnitPrice: number;
  currency: string;
};

@Injectable()
export class TenantSpecialtiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: SpecialtyCatalogService,
  ) {}

  async replace(
    tenantId: string,
    specialtyCodes: string[],
    actorId: string,
  ): Promise<SpecialtySelectionResult> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const specialties = await this.catalog.resolveActiveCodes(specialtyCodes, tx);
      const subscription = await tx.tenantSubscription.findUnique({ where: { tenantId } });
      if (!subscription) throw new NotFoundException('Suscripción no encontrada');
      const [previousSpecialties, previousModules] = await Promise.all([
        tx.tenantSpecialty.findMany({ where: { tenantId }, select: { specialtyId: true } }),
        tx.tenantModule.findMany({
          where: { tenantId },
          select: { moduleKey: true, enabled: true },
          orderBy: { moduleKey: 'asc' },
        }),
      ]);
      const previousMonthlyPrice = monthlyTotal(subscription, previousSpecialties.length);
      const result = await this.applySelection(tx, { tenantId, subscription, specialties });
      const masterChange = result.masterSpecialtyChange;
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: 'UPDATE',
          entity: 'TENANT',
          entityId: tenantId,
          changes: {
            before: {
              specialtyIds: previousSpecialties.map(({ specialtyId }) => specialtyId).sort(),
              modules: previousModules,
              monthlyPrice: previousMonthlyPrice,
              ...(masterChange && { masterSpecialtyId: masterChange.fromSpecialtyId }),
            },
            after: {
              specialtyIds: result.specialties.map(({ id }) => id).sort(),
              modules: result.modules,
              monthlyPrice: result.pricing.totalMonthly,
              ...(masterChange && { masterSpecialtyId: masterChange.toSpecialtyId }),
            },
          },
        },
      });
      return result;
    });
  }

  async applySelection(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; subscription: TenantSubscription; specialties: CatalogSpecialty[] },
  ): Promise<SpecialtySelectionResult> {
    const { tenantId, subscription, specialties } = input;
    if (specialties.length === 0) {
      throw new BadRequestException({
        code: 'SPECIALTY_SELECTION_REQUIRED',
        message: 'Selecciona al menos una especialidad.',
      });
    }
    const selectedIds = specialties.map(({ id }) => id);
    const [existingSelection, existingBilling, existingModules] = await Promise.all([
      tx.tenantSpecialty.findMany({ where: { tenantId }, select: { specialtyId: true } }),
      tx.subscriptionSpecialty.findMany({
        where: { tenantSubscriptionId: subscription.id },
        select: { specialtyId: true },
      }),
      tx.tenantModule.findMany({ where: { tenantId }, select: { moduleKey: true, enabled: true } }),
    ]);
    const oldIds = existingSelection.map(({ specialtyId }) => specialtyId);
    const removeIds = oldIds.filter((id) => !selectedIds.includes(id));
    // The master of a personal practice attends with one of its specialties: when that one goes,
    // the profile moves to the first one selected instead of blocking the change.
    const owner = removeIds.length ? await this.personalOwnerProfile(tx, tenantId) : null;
    const movedOwner =
      owner && removeIds.includes(owner.specialtyId)
        ? { ...owner, toSpecialtyId: selectedIds[0] }
        : null;
    for (const specialtyId of removeIds) {
      const activeProfessional = await tx.professionalProfile.findFirst({
        where: {
          specialtyId,
          isActive: true,
          user: { tenantId, isActive: true },
          ...(movedOwner && { userId: { not: movedOwner.userId } }),
        },
        select: { userId: true },
      });
      if (activeProfessional) {
        throw new ConflictException({
          code: 'SPECIALTY_IN_USE_BY_ACTIVE_PROFESSIONAL',
          message: 'La especialidad tiene profesionales activos.',
        });
      }
      const futureAppointment = await tx.appointment.findFirst({
        where: {
          tenantId,
          specialtyId,
          startTime: { gt: new Date() },
          status: { not: 'CANCELLED' },
        },
        select: { id: true },
      });
      if (futureAppointment) {
        throw new ConflictException({
          code: 'SPECIALTY_HAS_FUTURE_APPOINTMENTS',
          message: 'La especialidad tiene citas futuras.',
        });
      }
    }

    const addIds = selectedIds.filter((id) => !oldIds.includes(id));
    if (removeIds.length)
      await tx.tenantSpecialty.deleteMany({ where: { tenantId, specialtyId: { in: removeIds } } });
    if (addIds.length)
      await tx.tenantSpecialty.createMany({
        data: addIds.map((specialtyId) => ({ tenantId, specialtyId })),
      });
    if (movedOwner) {
      // Future appointments with the removed specialty were rejected above.
      await tx.professionalProfile.update({
        where: { userId: movedOwner.userId },
        data: { specialtyId: movedOwner.toSpecialtyId },
      });
      await tx.professionalSpecialty.deleteMany({ where: { userId: movedOwner.userId } });
      await tx.professionalSpecialty.create({
        data: { userId: movedOwner.userId, specialtyId: movedOwner.toSpecialtyId, isPrimary: true },
      });
    }

    const billedIds = existingBilling.map(({ specialtyId }) => specialtyId);
    const removeBilled = billedIds.filter((id) => !selectedIds.includes(id));
    const addBilled = selectedIds.filter((id) => !billedIds.includes(id));
    if (removeBilled.length)
      await tx.subscriptionSpecialty.deleteMany({
        where: { tenantSubscriptionId: subscription.id, specialtyId: { in: removeBilled } },
      });
    if (addBilled.length)
      await tx.subscriptionSpecialty.createMany({
        data: addBilled.map((specialtyId) => ({
          tenantSubscriptionId: subscription.id,
          specialtyId,
        })),
      });

    const desiredKeys = [
      ...new Set(specialties.flatMap(({ modules }) => modules.map(({ moduleKey }) => moduleKey))),
    ].sort();
    const existingKeys = existingModules.map(({ moduleKey }) => moduleKey);
    const obsoleteCandidates = existingKeys.filter((key) => !desiredKeys.includes(key));
    const catalogOwners = obsoleteCandidates.length
      ? await tx.specialtyModule.findMany({
          where: { moduleKey: { in: obsoleteCandidates } },
          select: { moduleKey: true },
        })
      : [];
    const ownedKeys = new Set(catalogOwners.map(({ moduleKey }) => moduleKey));
    // core.* sections are assigned by the platform administrator, never by a specialty selection.
    const removeKeys = obsoleteCandidates.filter(
      (key) => ownedKeys.has(key) && !key.startsWith('core.'),
    );
    const addKeys = desiredKeys.filter(
      (key) => !existingKeys.includes(key) && !key.startsWith('core.'),
    );
    if (removeKeys.length)
      await tx.tenantModule.deleteMany({ where: { tenantId, moduleKey: { in: removeKeys } } });
    if (addKeys.length)
      await tx.tenantModule.createMany({
        data: addKeys.map((moduleKey) => ({ tenantId, moduleKey, enabled: true })),
      });

    const totalMonthly = monthlyTotal(subscription, specialties.length);
    const billableSpecialties = Math.max(0, specialties.length - subscription.includedSpecialties);
    const pricing: SpecialtyPricing = {
      basePlanPrice: Number(subscription.basePrice),
      specialtyAddonsPrice:
        Math.round(billableSpecialties * Number(subscription.specialtyPrice) * 100) / 100,
      totalMonthly,
      includedSpecialties: subscription.includedSpecialties,
      selectedSpecialties: specialties.length,
      billableSpecialties,
      specialtyUnitPrice: Number(subscription.specialtyPrice),
      currency: subscription.currency,
    };
    return {
      tenantId,
      specialties,
      modules: [
        ...existingModules.filter(({ moduleKey }) => !removeKeys.includes(moduleKey)),
        ...addKeys.map((moduleKey) => ({ moduleKey, enabled: true })),
      ].sort((a, b) => a.moduleKey.localeCompare(b.moduleKey)),
      pricing,
      ...(movedOwner && {
        masterSpecialtyChange: {
          userId: movedOwner.userId,
          fromSpecialtyId: movedOwner.specialtyId,
          toSpecialtyId: movedOwner.toSpecialtyId,
        },
      }),
    };
  }

  /** The professional profile of a personal practice's master, if it has one. */
  private async personalOwnerProfile(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<{ userId: string; specialtyId: string } | null> {
    const master = await tx.user.findFirst({
      where: { tenantId, role: UserRole.MASTER, tenant: { tenantType: TenantType.PERSONAL } },
      select: { id: true, professionalProfile: { select: { specialtyId: true } } },
    });
    return master?.professionalProfile
      ? { userId: master.id, specialtyId: master.professionalProfile.specialtyId }
      : null;
  }

  async updateModule(tenantId: string, moduleKey: string, enabled: boolean, actorId: string) {
    if (moduleKey.startsWith('core.')) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'SECTION_MANAGED_BY_PLATFORM',
        message: 'Esta sección la administra la plataforma.',
      });
    }
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const owner = await tx.tenantSpecialty.findFirst({
        where: { tenantId, specialty: { isActive: true, modules: { some: { moduleKey } } } },
        select: { specialtyId: true },
      });
      if (!owner)
        throw new ConflictException({
          code: 'MODULE_SPECIALTY_NOT_ENABLED',
          message: 'El módulo requiere una especialidad habilitada.',
        });
      const module = await tx.tenantModule.findUnique({
        where: { tenantId_moduleKey: { tenantId, moduleKey } },
      });
      if (!module) {
        if (!enabled)
          throw new NotFoundException('El módulo no está configurado para este consultorio');
      } else if (module.enabled === enabled) {
        return module;
      }
      const updated = module
        ? await tx.tenantModule.update({ where: { id: module.id }, data: { enabled } })
        : await tx.tenantModule.create({ data: { tenantId, moduleKey, enabled: true } });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: actorId,
          action: 'UPDATE',
          entity: 'TENANT',
          entityId: tenantId,
          changes: {
            before: { module: { key: moduleKey, enabled: module?.enabled ?? null } },
            after: { module: { key: moduleKey, enabled } },
          },
        },
      });
      return updated;
    });
  }
}
