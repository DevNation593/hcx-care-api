import { invoiceMonthlyUsage } from '../invoicing/invoice-requests.service';
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { monthlyTotal } from '../plans/plan-values';

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
        plan: { select: { id: true, code: true, name: true } },
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
        plan: subscription.plan,
        status: subscription.status,
        basePrice: subscription.basePrice,
        // What the clinic pays a month: the plan price and the specialties beyond the included ones.
        monthlyTotal: monthlyTotal(subscription, subscription.specialties.length),
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

        specialties: subscription.specialties.map(({ specialty }) => specialty),
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
  // HELPER METHODS
  // ========================================

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
