import { invoiceMonthlyUsage } from '../invoicing/invoice-requests.service';
import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanType, TenantType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ModuleName } from './dto/customize-features.dto';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import {
  ALL_MODULES,
  MODULE_PRICING,
  PLAN_SPECIALTY_LIMITS,
  SPECIALTY_PRICE_PER_MONTH,
  calculateSubscriptionPrice,
  getPlanFeatureFlags,
  getPlanIncludedModules,
  getPlanLimits,
  moduleToDbKey,
} from './subscription-pricing';

@Injectable()
export class SubscriptionService {
  constructor(private prisma: PrismaService) {}

  // ========================================
  // GET CURRENT SUBSCRIPTION
  // ========================================
  async getCurrentSubscription(tenantId: string) {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      include: {
        specialties: {
          include: { specialty: { select: { code: true, name: true } } },
        },
        tenant: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    });

    if (!subscription) {
      throw new BadRequestException('No se encontró suscripción para este tenant');
    }

    const professionalsCount = await this.prisma.professionalProfile.count({
      where: { isActive: true, user: { tenantId } },
    });

    // Calculate remaining trial days
    const trialDaysRemaining = subscription.trialEndsAt
      ? Math.max(
          0,
          Math.ceil((subscription.trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
        )
      : 0;

    // Calculate billing cycle days
    const billingCycleDaysRemaining = subscription.currentPeriodEnd
      ? Math.max(
          0,
          Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
        )
      : 0;

    return {
      subscription: {
        id: subscription.id,
        planType: subscription.planType,
        status: subscription.status,
        basePrice: subscription.basePrice,
        pricePerSeat: subscription.pricePerSeat,
        currency: subscription.currency,
        includedSpecialties: subscription.includedSpecialties,
        specialtyPrice: subscription.specialtyPrice,
        monthlyElectronicInvoicesLimit: subscription.monthlyElectronicInvoicesLimit,
        monthlyElectronicInvoicesUsed: await invoiceMonthlyUsage(this.prisma, tenantId),

        // Dates
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        trialEndsAt: subscription.trialEndsAt,
        trialDaysRemaining,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        billingCycleDaysRemaining,

        // Seats
        seatsPsychologistsMax: subscription.seatsPsychologistsMax,
        seatsPsychologistsUsed: professionalsCount,
        seatsAvailable: subscription.seatsPsychologistsMax - professionalsCount,

        // Limits
        limits: {
          maxActivePatients: subscription.maxActivePatients,
          storageGB: subscription.storageGB,
          monthlyNotifications: subscription.monthlyNotificationsLimit,
        },

        // Features
        features: this.extractFeatures(subscription),
        specialties: subscription.specialties.map(({ specialty }) => specialty),

        // Scheduled changes
        scheduledChange: subscription.scheduledPlanChange
          ? {
              newPlan: subscription.scheduledPlanChange,
              effectiveDate: subscription.scheduledPlanChangeAt,
            }
          : null,
      },
      tenant: subscription.tenant,
    };
  }

  // ========================================
  // GET USAGE METRICS
  // ========================================
  async getUsageMetrics(tenantId: string) {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription) {
      throw new BadRequestException('Suscripción no encontrada');
    }

    // Get real-time counts
    const [
      professionalsCount,
      activePatientsCount,
      notificationsThisMonth,
      appointmentsThisMonth,
      clinicalNotesTotal,
    ] = await Promise.all([
      // Active professional profiles (seats used)
      this.prisma.professionalProfile.count({
        where: { isActive: true, user: { tenantId } },
      }),

      // Active patients
      this.prisma.patient.count({
        where: {
          tenantId,
          deletedAt: null,
        },
      }),

      // Notifications sent this month
      this.prisma.notificationLog.count({
        where: {
          tenantId,
          createdAt: {
            gte: this.getStartOfMonth(),
          },
        },
      }),

      // Appointments created this month
      this.prisma.appointment.count({
        where: {
          tenantId,
          createdAt: {
            gte: this.getStartOfMonth(),
          },
        },
      }),

      // Total clinical notes
      this.prisma.clinicalNote.count({
        where: { tenantId, deletedAt: null },
      }),
    ]);

    const storageUsedGB = Number(subscription.storageUsedBytes) / (1024 * 1024 * 1024);

    return {
      period: {
        start: subscription.currentPeriodStart,
        end: subscription.currentPeriodEnd,
      },

      usage: {
        // Seats
        seats: {
          used: professionalsCount,
          limit: subscription.seatsPsychologistsMax,
          percentage: (professionalsCount / subscription.seatsPsychologistsMax) * 100,
          available: subscription.seatsPsychologistsMax - professionalsCount,
        },

        // Patients
        patients: {
          active: activePatientsCount,
          limit: subscription.maxActivePatients,
          percentage: (activePatientsCount / subscription.maxActivePatients) * 100,
          available: subscription.maxActivePatients - activePatientsCount,
        },

        // Storage
        storage: {
          usedGB: parseFloat(storageUsedGB.toFixed(2)),
          limitGB: subscription.storageGB,
          percentage:
            subscription.storageGB > 0 ? (storageUsedGB / subscription.storageGB) * 100 : 0,
          availableGB:
            subscription.storageGB > 0
              ? parseFloat((subscription.storageGB - storageUsedGB).toFixed(2))
              : 0,
        },

        // Notifications
        notifications: {
          sentThisMonth: notificationsThisMonth,
          limit: subscription.monthlyNotificationsLimit,
          percentage: (notificationsThisMonth / subscription.monthlyNotificationsLimit) * 100,
          available: subscription.monthlyNotificationsLimit - notificationsThisMonth,
          resetDate: this.getStartOfNextMonth(),
        },
      },

      activity: {
        appointmentsThisMonth,
        totalClinicalNotes: clinicalNotesTotal,
      },

      // Warnings
      warnings: this.generateUsageWarnings({
        professionalsCount,
        seatsPsychologistsMax: subscription.seatsPsychologistsMax,
        activePatientsCount,
        maxActivePatients: subscription.maxActivePatients,
        storageUsedGB,
        storageGB: subscription.storageGB,
        notificationsThisMonth,
        monthlyNotificationsLimit: subscription.monthlyNotificationsLimit,
      }),
    };
  }

  // ========================================
  // DOWNGRADE PLAN
  // ========================================
  async downgradePlan(tenantId: string, userId: string, newPlan: PlanType) {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription) {
      throw new BadRequestException('Suscripción no encontrada');
    }

    // Validate downgrade path
    const planHierarchy: PlanType[] = [
      'TRIAL',
      'PERSONAL_BASIC',
      'PERSONAL_PRO',
      'CLINIC_BASIC',
      'CLINIC_PRO',
      'CLINIC_ENTERPRISE',
    ];
    const currentIndex = planHierarchy.indexOf(subscription.planType);
    const newIndex = planHierarchy.indexOf(newPlan);

    if (newIndex >= currentIndex) {
      throw new BadRequestException('Esto no es una degradación. Use upgradePlan para mejoras.');
    }

    // Validate tenant type compatibility
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    const isPersonalPlan = newPlan.startsWith('PERSONAL_');

    if (isPersonalPlan && tenant?.tenantType === 'CLINIC') {
      throw new BadRequestException(
        'No se puede degradar a un plan personal en una cuenta de clínica con múltiples profesionales activos. Primero desactive los perfiles adicionales.',
      );
    }

    // Get new plan limits
    const newPlanLimits = getPlanLimits(newPlan);

    // Run pre-flight validations
    const validations = await this.validateDowngrade(tenantId, newPlanLimits);

    if (!validations.canDowngrade) {
      throw new ForbiddenException({
        error: 'DOWNGRADE_BLOCKED',
        message: 'No se puede degradar: Por favor resuelva los siguientes problemas primero',
        validations: validations.errors,
      });
    }

    // Schedule downgrade for end of billing period
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx, { tenantId, userId });

      const result = await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          scheduledPlanChange: newPlan,
          scheduledPlanChangeAt: subscription.currentPeriodEnd,
        },
      });

      // Log event
      await tx.subscriptionEvent.create({
        data: {
          tenantId,
          eventType: 'PLAN_DOWNGRADED',
          previousPlan: subscription.planType,
          newPlan,
          metadata: {
            effectiveDate: subscription.currentPeriodEnd,
            warnings: validations.warnings,
          },
          triggeredByUserId: userId,
        },
      });

      return result;
    });

    return {
      success: true,
      effectiveDate: subscription.currentPeriodEnd,
      daysUntilChange: subscription.currentPeriodEnd
        ? Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : 0,
      currentPlan: subscription.planType,
      newPlan,
      warnings: validations.warnings,
      message: `Degradación programada para ${subscription.currentPeriodEnd?.toLocaleDateString()}. Puede cancelar este cambio en cualquier momento antes de esa fecha.`,
    };
  }

  // ========================================
  // CHECK FEATURE ACCESS
  // ========================================
  async checkFeatureAccess(tenantId: string, feature: string): Promise<boolean> {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription || (subscription.status !== 'ACTIVE' && subscription.status !== 'TRIALING')) {
      return false;
    }

    const featureKey =
      `feature${feature.charAt(0).toUpperCase()}${feature.slice(1)}` as keyof typeof subscription;
    return subscription[featureKey] === true;
  }

  // ========================================
  // CHECK USAGE LIMIT
  // ========================================
  // CUSTOMIZE FEATURES (module selection)
  // ========================================
  async customizeFeatures(tenantId: string, userId: string, selectedModules: ModuleName[]) {
    // clinicalNotes is always required
    if (!selectedModules.includes('clinicalNotes')) {
      selectedModules = ['clinicalNotes', ...selectedModules];
    }

    // Build feature flags update object
    const featureFlags: Record<string, boolean> = {};
    for (const mod of ALL_MODULES) {
      featureFlags[moduleToDbKey(mod)] = selectedModules.includes(mod);
    }

    return runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      const subscription = await tx.tenantSubscription.findUnique({ where: { tenantId } });
      if (!subscription) throw new BadRequestException('Suscripción no encontrada');
      if (subscription.status !== 'ACTIVE' && subscription.status !== 'TRIALING') {
        throw new ForbiddenException('Solo puede personalizar módulos con una suscripción activa.');
      }

      const includedModules = getPlanIncludedModules(subscription.planType);
      const addonsDetail: { module: string; price: number }[] = [];
      for (const mod of new Set(selectedModules)) {
        if (!includedModules.includes(mod)) {
          addonsDetail.push({ module: mod, price: MODULE_PRICING[mod] });
        }
      }
      const specialtyCount = await tx.tenantSpecialty.count({ where: { tenantId } });
      const pricing = calculateSubscriptionPrice({
        planType: subscription.planType,
        selectedModules,
        specialtyCount,
        specialtyUnitPrice: Number(subscription.specialtyPrice),
      });
      const addonsCost = pricing.featureAddonsPrice;

      const updated = await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          ...featureFlags,
          basePrice: new Decimal(pricing.totalMonthly),
        },
      });

      await tx.subscriptionEvent.create({
        data: {
          tenantId,
          eventType: 'FEATURE_ENABLED',
          previousPlan: subscription.planType,
          newPlan: subscription.planType,
          metadata: {
            selectedModules,
            addons: addonsDetail,
            addonsCost,
            totalPrice: pricing.totalMonthly,
          },
          triggeredByUserId: userId,
        },
      });

      return {
        success: true,
        plan: subscription.planType,
        selectedModules,
        includedInPlan: includedModules,
        addons: addonsDetail,
        pricing: {
          ...pricing,
          addonsCost,
          currency: subscription.currency,
        },
        features: this.extractFeatures(updated),
      };
    });
  }

  // ========================================
  // GET PLANS CATALOG
  // ========================================
  getAvailablePlans(tenantType?: TenantType) {
    const allPlans = [
      'TRIAL',
      'PERSONAL_BASIC',
      'PERSONAL_PRO',
      'CLINIC_BASIC',
      'CLINIC_PRO',
      'CLINIC_ENTERPRISE',
    ] as PlanType[];

    const plans = allPlans
      .filter((p) => {
        if (!tenantType) return true;
        if (tenantType === 'PERSONAL') return p === 'TRIAL' || p.startsWith('PERSONAL_');
        return p === 'TRIAL' || p.startsWith('CLINIC_');
      })
      .map((planType) => {
        const limits = getPlanLimits(planType);
        const includedModules = getPlanIncludedModules(planType);
        return {
          planType,
          basePrice: Number(limits.basePrice),
          pricePerSeat: Number(limits.pricePerSeat),
          seatsIncluded: limits.seatsIncluded,
          maxActivePatients: limits.maxActivePatients,
          storageGB: limits.storageGB,
          monthlyNotificationsLimit: limits.monthlyNotificationsLimit,
          includedModules,
          availableAddons: ALL_MODULES.filter((m) => !includedModules.includes(m)).map((m) => ({
            module: m,
            pricePerMonth: MODULE_PRICING[m],
          })),
          specialtyPolicy: 'Cualquier especialidad disponible',
          includedSpecialties: PLAN_SPECIALTY_LIMITS[planType],
          specialtyPricePerMonth: SPECIALTY_PRICE_PER_MONTH,
          electronicInvoicesPerMonth: 50,
        };
      });

    return { plans, modulePricing: MODULE_PRICING };
  }

  // ========================================
  // CHECK USAGE LIMIT
  // ========================================
  async checkUsageLimit(
    tenantId: string,
    limitType: 'patients' | 'notifications' | 'storage',
    incrementBy: number = 1,
  ): Promise<{ allowed: boolean; reason?: string; current?: number; limit?: number }> {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription) {
      return { allowed: false, reason: 'Suscripción no encontrada' };
    }

    switch (limitType) {
      case 'patients':
        const currentPatients = await this.prisma.patient.count({
          where: { tenantId, deletedAt: null },
        });
        if (currentPatients + incrementBy > subscription.maxActivePatients) {
          return {
            allowed: false,
            reason: `Límite de pacientes alcanzado (${subscription.maxActivePatients})`,
            current: currentPatients,
            limit: subscription.maxActivePatients,
          };
        }
        break;

      case 'notifications':
        if (
          subscription.monthlyNotificationsSent + incrementBy >
          subscription.monthlyNotificationsLimit
        ) {
          return {
            allowed: false,
            reason: `Límite de notificaciones mensuales alcanzado (${subscription.monthlyNotificationsLimit})`,
            current: subscription.monthlyNotificationsSent,
            limit: subscription.monthlyNotificationsLimit,
          };
        }
        break;

      case 'storage':
        const storageUsedGB = Number(subscription.storageUsedBytes) / (1024 * 1024 * 1024);
        const incrementGB = incrementBy / (1024 * 1024 * 1024);
        if (storageUsedGB + incrementGB > subscription.storageGB) {
          return {
            allowed: false,
            reason: `Límite de almacenamiento alcanzado (${subscription.storageGB} GB)`,
            current: parseFloat(storageUsedGB.toFixed(2)),
            limit: subscription.storageGB,
          };
        }
        break;
    }

    return { allowed: true };
  }

  // ========================================
  // INCREMENT USAGE
  // ========================================
  async incrementUsage(tenantId: string, metric: 'notifications' | 'storage', amount: number) {
    if (metric === 'notifications') {
      await this.prisma.tenantSubscription.update({
        where: { tenantId },
        data: {
          monthlyNotificationsSent: { increment: amount },
        },
      });
    } else if (metric === 'storage') {
      await this.prisma.tenantSubscription.update({
        where: { tenantId },
        data: {
          storageUsedBytes: { increment: amount },
        },
      });
    }
  }

  // ========================================
  // VALIDATE DOWNGRADE
  // ========================================
  /** Also used when a scheduled downgrade falls due: usage may have grown since the request. */
  async validateDowngrade(tenantId: string, newPlanLimits: any) {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check seats
    const professionalsCount = await this.prisma.professionalProfile.count({
      where: { isActive: true, user: { tenantId } },
    });

    if (professionalsCount > newPlanLimits.seatsIncluded) {
      errors.push(
        `Tiene ${professionalsCount} profesionales activos. El nuevo plan solo permite ${newPlanLimits.seatsIncluded}. Por favor desactive ${professionalsCount - newPlanLimits.seatsIncluded} perfil(es).`,
      );
    }

    // Check patients
    const activePatientsCount = await this.prisma.patient.count({
      where: { tenantId, deletedAt: null },
    });

    if (activePatientsCount > newPlanLimits.maxActivePatients) {
      errors.push(
        `Tiene ${activePatientsCount} pacientes activos. El nuevo plan solo permite ${newPlanLimits.maxActivePatients}.`,
      );
    }

    // Check storage
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (subscription) {
      const storageUsedGB = Number(subscription.storageUsedBytes) / (1024 * 1024 * 1024);

      if (storageUsedGB > newPlanLimits.storageGB) {
        errors.push(
          `Su uso de almacenamiento (${storageUsedGB.toFixed(2)} GB) excede el límite del nuevo plan (${newPlanLimits.storageGB} GB).`,
        );
      }

      // Generate warnings about feature loss
      const newFeatures = getPlanFeatureFlags(newPlanLimits.planType);

      if (subscription.featureAdvancedAnalytics && !newFeatures.featureAdvancedAnalytics) {
        warnings.push('Perderá acceso a Analíticas Avanzadas');
      }
      if (subscription.featureVideoConsultation && !newFeatures.featureVideoConsultation) {
        warnings.push('La integración de Video Consulta será deshabilitada');
      }
    }

    return {
      canDowngrade: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ========================================
  // HELPER METHODS
  // ========================================

  private extractFeatures(subscription: any) {
    return {
      clinicalNotes: subscription.featureClinicalNotes,
      clinicalNotesEncryption: subscription.featureClinicalNotesEncryption,
      attachments: subscription.featureAttachments,
      tasks: subscription.featureTasks,
      psychologicalTests: subscription.featurePsychologicalTests,
      webPush: subscription.featureWebPush,
      fcmPush: subscription.featureFCMPush,
      advancedAnalytics: subscription.featureAdvancedAnalytics,
      videoConsultation: subscription.featureVideoConsultation,
      calendarSync: subscription.featureCalendarSync,
      onlineSchedulingWidget: subscription.featureOnlineSchedulingWidget,
      customReports: subscription.featureCustomReports,
      apiAccess: subscription.featureAPIAccess,
      whatsAppIntegration: subscription.featureWhatsAppIntegration,
      sso: subscription.featureSSO,
    };
  }

  private generateUsageWarnings(metrics: any) {
    const warnings: string[] = [];

    if (metrics.professionalsCount / metrics.seatsPsychologistsMax >= 0.8) {
      warnings.push('Se está acercando al límite de cupos para profesionales activos');
    }

    if (metrics.activePatientsCount / metrics.maxActivePatients >= 0.9) {
      warnings.push('Se está acercando al límite de pacientes');
    }

    if (metrics.storageGB > 0 && metrics.storageUsedGB / metrics.storageGB >= 0.85) {
      warnings.push('Se está acercando al límite de almacenamiento');
    }

    if (metrics.notificationsThisMonth / metrics.monthlyNotificationsLimit >= 0.9) {
      warnings.push('Se está acercando al límite mensual de notificaciones');
    }

    return warnings;
  }

  private getStartOfMonth(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }

  private getStartOfNextMonth(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
}
