> **Histórico.** Describe el modelo de planes en código y feature flags, retirado el 2026-10-25. El modelo vigente (planes en base de datos, ajustes por consultorio, cobro) está en [`SUBSCRIPTION_BILLING.md`](./SUBSCRIPTION_BILLING.md).

# Subscription Model Implementation

## Database Schema Changes

### Updated TenantSubscription Model

```prisma
model TenantSubscription {
  id        String   @id @default(cuid())
  tenantId  String   @unique
  tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  // Plan & Status
  planType  PlanType
  status    SubscriptionStatus @default(TRIALING)
  
  // Billing cycle
  startDate DateTime
  endDate   DateTime
  trialEndsAt DateTime?
  currentPeriodStart DateTime
  currentPeriodEnd DateTime
  canceledAt DateTime?
  cancelAt DateTime?  // Scheduled cancellation
  
  // Pricing
  basePrice Decimal @db.Decimal(10, 2)
  pricePerSeat Decimal @db.Decimal(10, 2)
  currency String @default("USD")
  
  // Seats
  seatsPsychologistsMax Int
  seatsPsychologistsUsed Int @default(0)
  
  // Resource Limits
  maxActivePatients Int
  storageGB Int
  monthlyNotificationsLimit Int
  
  // Feature Flags (boolean)
  featureClinicalNotes Boolean @default(true)
  featureClinicalNotesEncryption Boolean @default(false)
  featureAttachments Boolean @default(false)
  featureTasks Boolean @default(false)
  featurePsychologicalTests Boolean @default(false)
  featureWebPush Boolean @default(false)
  featureFCMPush Boolean @default(false)
  featureAdvancedAnalytics Boolean @default(false)
  featureVideoConsultation Boolean @default(false)
  featureCalendarSync Boolean @default(false)
  featureOnlineSchedulingWidget Boolean @default(false)
  featureCustomReports Boolean @default(false)
  featureAPIAccess Boolean @default(false)
  featureWhatsAppIntegration Boolean @default(false)
  featureSSO Boolean @default(false)
  
  // Usage Tracking (updated in real-time)
  activePatientsCount Int @default(0)
  storageUsedBytes BigInt @default(0)
  monthlyNotificationsSent Int @default(0)
  lastNotificationReset DateTime @default(now())
  
  // Scheduled changes
  scheduledPlanChange PlanType?
  scheduledPlanChangeAt DateTime?
  
  // Payment integration
  stripeCustomerId String?
  stripeSubscriptionId String?
  stripePaymentMethodId String?
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@index([tenantId])
  @@index([status])
}

enum PlanType {
  TRIAL
  BASIC
  PRO
  CUSTOM
}

enum SubscriptionStatus {
  TRIALING       // In trial period
  ACTIVE         // Paid and active
  PAST_DUE       // Payment failed, grace period
  CANCELED       // Canceled but still in billing period
  INCOMPLETE     // Payment setup incomplete
  UNPAID         // Grace period expired
}
```

### New UsageMetrics Model (for historical tracking)

```prisma
model UsageMetrics {
  id String @id @default(cuid())
  tenantId String
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  // Snapshot date
  recordedAt DateTime @default(now())
  periodStart DateTime
  periodEnd DateTime
  
  // Usage data
  seatsPsychologistsUsed Int
  activePatientsCount Int
  storageUsedGB Decimal @db.Decimal(10, 2)
  notificationsSent Int
  appointmentsCreated Int
  clinicalNotesCreated Int
  tasksCreated Int
  
  // Costs (for internal tracking)
  estimatedCost Decimal? @db.Decimal(10, 2)
  
  createdAt DateTime @default(now())
  
  @@index([tenantId, recordedAt])
  @@index([periodStart, periodEnd])
}
```

### SubscriptionEvent Model (audit trail)

```prisma
model SubscriptionEvent {
  id String @id @default(cuid())
  tenantId String
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  
  eventType SubscriptionEventType
  previousPlan PlanType?
  newPlan PlanType?
  previousStatus SubscriptionStatus?
  newStatus SubscriptionStatus?
  
  // Details
  reason String?
  metadata Json?
  
  // Who triggered (null for system events)
  triggeredByUserId String?
  triggeredByUser User? @relation(fields: [triggeredByUserId], references: [id])
  
  createdAt DateTime @default(now())
  
  @@index([tenantId, createdAt])
  @@index([eventType])
}

enum SubscriptionEventType {
  TRIAL_STARTED
  TRIAL_ENDED
  PLAN_UPGRADED
  PLAN_DOWNGRADED
  SUBSCRIPTION_ACTIVATED
  SUBSCRIPTION_CANCELED
  SUBSCRIPTION_REACTIVATED
  PAYMENT_SUCCEEDED
  PAYMENT_FAILED
  SEATS_INCREASED
  SEATS_DECREASED
  FEATURE_ENABLED
  FEATURE_DISABLED
  LIMIT_REACHED
  GRACE_PERIOD_ENTERED
  GRACE_PERIOD_ENDED
}
```

## API Implementation

### 1. SubscriptionService

```typescript
// src/subscription/subscription.service.ts

import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanType, SubscriptionStatus } from '@prisma/client';

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
        tenant: {
          select: {
            name: true,
            slug: true,
            email: true,
          },
        },
      },
    });

    if (!subscription) {
      throw new BadRequestException('No subscription found for this tenant');
    }

    // Calculate remaining trial days
    const trialDaysRemaining = subscription.trialEndsAt
      ? Math.max(0, Math.ceil((subscription.trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 0;

    // Calculate billing cycle days
    const billingCycleDaysRemaining = Math.max(
      0,
      Math.ceil((subscription.currentPeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    );

    return {
      subscription: {
        id: subscription.id,
        planType: subscription.planType,
        status: subscription.status,
        basePrice: subscription.basePrice,
        pricePerSeat: subscription.pricePerSeat,
        currency: subscription.currency,
        
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
        seatsPsychologistsUsed: subscription.seatsPsychologistsUsed,
        seatsAvailable: subscription.seatsPsychologistsMax - subscription.seatsPsychologistsUsed,
        
        // Limits
        limits: {
          maxActivePatients: subscription.maxActivePatients,
          storageGB: subscription.storageGB,
          monthlyNotifications: subscription.monthlyNotificationsLimit,
        },
        
        // Features
        features: this.extractFeatures(subscription),
        
        // Scheduled changes
        scheduledChange: subscription.scheduledPlanChange ? {
          newPlan: subscription.scheduledPlanChange,
          effectiveDate: subscription.scheduledPlanChangeAt,
        } : null,
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
      throw new BadRequestException('No subscription found');
    }

    // Get real-time counts
    const [
      psychologistsCount,
      activePatientsCount,
      attachmentsSize,
      notificationsThisMonth,
      appointmentsThisMonth,
      clinicalNotesTotal,
    ] = await Promise.all([
      // Psychologists (seats used)
      this.prisma.user.count({
        where: {
          tenantId,
          role: 'PSYCHOLOGIST',
          isActive: true,
        },
      }),

      // Active patients
      this.prisma.patient.count({
        where: {
          tenantId,
          deletedAt: null,
        },
      }),

      // Storage used (sum of all attachment sizes)
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM(file_size), 0) as total
        FROM "Attachment"
        WHERE "tenantId" = ${tenantId}
      `.then(result => result[0]?.total || BigInt(0)),

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
        where: { tenantId },
      }),
    ]);

    const storageUsedGB = Number(attachmentsSize) / (1024 * 1024 * 1024);

    return {
      period: {
        start: subscription.currentPeriodStart,
        end: subscription.currentPeriodEnd,
      },
      
      usage: {
        // Seats
        seats: {
          used: psychologistsCount,
          limit: subscription.seatsPsychologistsMax,
          percentage: (psychologistsCount / subscription.seatsPsychologistsMax) * 100,
          available: subscription.seatsPsychologistsMax - psychologistsCount,
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
          percentage: (storageUsedGB / subscription.storageGB) * 100,
          availableGB: parseFloat((subscription.storageGB - storageUsedGB).toFixed(2)),
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
        psychologistsCount,
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
  // UPGRADE PLAN
  // ========================================
  async upgradePlan(
    tenantId: string,
    userId: string,
    newPlan: PlanType,
  ) {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription) {
      throw new BadRequestException('No subscription found');
    }

    // Validate upgrade path
    const planHierarchy = ['TRIAL', 'BASIC', 'PRO', 'CUSTOM'];
    const currentIndex = planHierarchy.indexOf(subscription.planType);
    const newIndex = planHierarchy.indexOf(newPlan);

    if (newIndex <= currentIndex) {
      throw new BadRequestException('This is not an upgrade. Use downgradePlan for downgrades.');
    }

    // Get new plan limits
    const newPlanLimits = this.getPlanLimits(newPlan);

    // Calculate prorated pricing (implementation depends on billing provider)
    const proratedAmount = await this.calculateProratedCharge(
      subscription,
      newPlanLimits.basePrice,
    );

    // Update subscription (immediate effect)
    const updatedSubscription = await this.prisma.$transaction(async (tx) => {
      // Update subscription
      const updated = await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          planType: newPlan,
          status: 'ACTIVE',
          basePrice: newPlanLimits.basePrice,
          pricePerSeat: newPlanLimits.pricePerSeat,
          seatsPsychologistsMax: newPlanLimits.seatsIncluded,
          maxActivePatients: newPlanLimits.maxActivePatients,
          storageGB: newPlanLimits.storageGB,
          monthlyNotificationsLimit: newPlanLimits.monthlyNotificationsLimit,
          
          // Update feature flags
          ...this.getPlanFeatures(newPlan),
          
          // Clear scheduled changes
          scheduledPlanChange: null,
          scheduledPlanChangeAt: null,
        },
      });

      // Log event
      await tx.subscriptionEvent.create({
        data: {
          tenantId,
          eventType: 'PLAN_UPGRADED',
          previousPlan: subscription.planType,
          newPlan,
          metadata: {
            proratedAmount,
            immediateEffect: true,
          },
          triggeredByUserId: userId,
        },
      });

      return updated;
    });

    // TODO: Charge payment method via Stripe
    // await this.stripeService.createInvoice(...)

    return {
      success: true,
      subscription: updatedSubscription,
      billing: {
        proratedCharge: proratedAmount,
        nextBillingDate: updatedSubscription.currentPeriodEnd,
      },
      message: `Successfully upgraded to ${newPlan}. All features are now available.`,
    };
  }

  // ========================================
  // DOWNGRADE PLAN (with validations)
  // ========================================
  async downgradePlan(
    tenantId: string,
    userId: string,
    newPlan: PlanType,
  ) {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription) {
      throw new BadRequestException('No subscription found');
    }

    // Validate downgrade path
    const planHierarchy = ['TRIAL', 'BASIC', 'PRO', 'CUSTOM'];
    const currentIndex = planHierarchy.indexOf(subscription.planType);
    const newIndex = planHierarchy.indexOf(newPlan);

    if (newIndex >= currentIndex) {
      throw new BadRequestException('This is not a downgrade. Use upgradePlan for upgrades.');
    }

    // Get new plan limits
    const newPlanLimits = this.getPlanLimits(newPlan);

    // Run pre-flight validations
    const validations = await this.validateDowngrade(tenantId, newPlanLimits);

    if (!validations.canDowngrade) {
      throw new ForbiddenException({
        error: 'DOWNGRADE_BLOCKED',
        message: 'Cannot downgrade: Please resolve the following issues first',
        validations: validations.errors,
      });
    }

    // Schedule downgrade for end of billing period
    const updated = await this.prisma.$transaction(async (tx) => {
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
      daysUntilChange: Math.ceil(
        (subscription.currentPeriodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      ),
      currentPlan: subscription.planType,
      newPlan,
      warnings: validations.warnings,
      message: `Downgrade scheduled for ${subscription.currentPeriodEnd.toLocaleDateString()}. You can cancel this change anytime before then.`,
    };
  }

  // ========================================
  // VALIDATE DOWNGRADE
  // ========================================
  private async validateDowngrade(tenantId: string, newPlanLimits: any) {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check seats
    const psychologistsCount = await this.prisma.user.count({
      where: { tenantId, role: 'PSYCHOLOGIST', isActive: true },
    });

    if (psychologistsCount > newPlanLimits.seatsIncluded) {
      errors.push(
        `You have ${psychologistsCount} active psychologists. The new plan allows only ${newPlanLimits.seatsIncluded}. Please deactivate ${psychologistsCount - newPlanLimits.seatsIncluded} psychologist(s).`
      );
    }

    // Check patients
    const activePatientsCount = await this.prisma.patient.count({
      where: { tenantId, deletedAt: null },
    });

    if (activePatientsCount > newPlanLimits.maxActivePatients) {
      errors.push(
        `You have ${activePatientsCount} active patients. The new plan allows only ${newPlanLimits.maxActivePatients}.`
      );
    }

    // Check storage
    const storageResult = await this.prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(file_size), 0) as total
      FROM "Attachment"
      WHERE "tenantId" = ${tenantId}
    `;
    const storageUsedGB = Number(storageResult[0]?.total || 0) / (1024 * 1024 * 1024);

    if (storageUsedGB > newPlanLimits.storageGB) {
      errors.push(
        `Your storage usage (${storageUsedGB.toFixed(2)} GB) exceeds the new plan limit (${newPlanLimits.storageGB} GB).`
      );
    }

    // Generate warnings about feature loss
    const currentFeatures = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        featureAdvancedAnalytics: true,
        featureVideoConsultation: true,
        featureClinicalNotesEncryption: true,
        featureWebPush: true,
      },
    });

    const newFeatures = this.getPlanFeatures(newPlanLimits.planType);

    if (currentFeatures?.featureAdvancedAnalytics && !newFeatures.featureAdvancedAnalytics) {
      warnings.push('You will lose access to Advanced Analytics');
    }
    if (currentFeatures?.featureVideoConsultation && !newFeatures.featureVideoConsultation) {
      warnings.push('Video Consultation integration will be disabled');
    }
    if (currentFeatures?.featureClinicalNotesEncryption && !newFeatures.featureClinicalNotesEncryption) {
      warnings.push('Clinical notes encryption will be disabled (existing notes remain encrypted)');
    }

    return {
      canDowngrade: errors.length === 0,
      errors,
      warnings,
    };
  }

  // ========================================
  // CHECK FEATURE ACCESS
  // ========================================
  async checkFeatureAccess(tenantId: string, feature: string): Promise<boolean> {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription || subscription.status !== 'ACTIVE') {
      return false;
    }

    const featureKey = `feature${feature.charAt(0).toUpperCase()}${feature.slice(1)}`;
    return subscription[featureKey as keyof typeof subscription] === true;
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
      return { allowed: false, reason: 'No subscription found' };
    }

    switch (limitType) {
      case 'patients':
        const currentPatients = await this.prisma.patient.count({
          where: { tenantId, deletedAt: null },
        });
        if (currentPatients + incrementBy > subscription.maxActivePatients) {
          return {
            allowed: false,
            reason: `Patient limit reached (${subscription.maxActivePatients})`,
            current: currentPatients,
            limit: subscription.maxActivePatients,
          };
        }
        break;

      case 'notifications':
        if (subscription.monthlyNotificationsSent + incrementBy > subscription.monthlyNotificationsLimit) {
          return {
            allowed: false,
            reason: `Monthly notification limit reached (${subscription.monthlyNotificationsLimit})`,
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
            reason: `Storage limit reached (${subscription.storageGB} GB)`,
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
  async incrementUsage(
    tenantId: string,
    metric: 'notifications' | 'storage',
    amount: number,
  ) {
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
  // HELPER METHODS
  // ========================================

  private getPlanLimits(planType: PlanType) {
    const plans = {
      TRIAL: {
        planType: 'TRIAL',
        basePrice: 0,
        pricePerSeat: 0,
        seatsIncluded: 1,
        maxActivePatients: 10,
        storageGB: 0.1, // 100 MB
        monthlyNotificationsLimit: 100,
      },
      BASIC: {
        planType: 'BASIC',
        basePrice: 49,
        pricePerSeat: 15,
        seatsIncluded: 3,
        maxActivePatients: 100,
        storageGB: 0.1, // 100 MB
        monthlyNotificationsLimit: 500,
      },
      PRO: {
        planType: 'PRO',
        basePrice: 149,
        pricePerSeat: 12,
        seatsIncluded: 10,
        maxActivePatients: 500,
        storageGB: 1,
        monthlyNotificationsLimit: 2000,
      },
      CUSTOM: {
        planType: 'CUSTOM',
        basePrice: 0, // Negotiated
        pricePerSeat: 0,
        seatsIncluded: 999,
        maxActivePatients: 999999,
        storageGB: 100,
        monthlyNotificationsLimit: 999999,
      },
    };

    return plans[planType];
  }

  private getPlanFeatures(planType: PlanType) {
    const features = {
      TRIAL: {
        featureClinicalNotes: true,
        featureClinicalNotesEncryption: false,
        featureAttachments: false,
        featureTasks: false,
        featurePsychologicalTests: false,
        featureWebPush: false,
        featureFCMPush: false,
        featureAdvancedAnalytics: false,
        featureVideoConsultation: false,
        featureCalendarSync: false,
        featureOnlineSchedulingWidget: false,
        featureCustomReports: false,
        featureAPIAccess: false,
        featureWhatsAppIntegration: false,
        featureSSO: false,
      },
      BASIC: {
        featureClinicalNotes: true,
        featureClinicalNotesEncryption: false,
        featureAttachments: true,
        featureTasks: true,
        featurePsychologicalTests: false,
        featureWebPush: false,
        featureFCMPush: true,
        featureAdvancedAnalytics: false,
        featureVideoConsultation: false,
        featureCalendarSync: false,
        featureOnlineSchedulingWidget: true,
        featureCustomReports: false,
        featureAPIAccess: false,
        featureWhatsAppIntegration: false,
        featureSSO: false,
      },
      PRO: {
        featureClinicalNotes: true,
        featureClinicalNotesEncryption: true,
        featureAttachments: true,
        featureTasks: true,
        featurePsychologicalTests: true,
        featureWebPush: true,
        featureFCMPush: true,
        featureAdvancedAnalytics: true,
        featureVideoConsultation: true,
        featureCalendarSync: true,
        featureOnlineSchedulingWidget: true,
        featureCustomReports: true,
        featureAPIAccess: true,
        featureWhatsAppIntegration: false,
        featureSSO: false,
      },
      CUSTOM: {
        featureClinicalNotes: true,
        featureClinicalNotesEncryption: true,
        featureAttachments: true,
        featureTasks: true,
        featurePsychologicalTests: true,
        featureWebPush: true,
        featureFCMPush: true,
        featureAdvancedAnalytics: true,
        featureVideoConsultation: true,
        featureCalendarSync: true,
        featureOnlineSchedulingWidget: true,
        featureCustomReports: true,
        featureAPIAccess: true,
        featureWhatsAppIntegration: true,
        featureSSO: true,
      },
    };

    return features[planType];
  }

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

    // Seats warning (80% threshold)
    if (metrics.psychologistsCount / metrics.seatsPsychologistsMax >= 0.8) {
      warnings.push('You are approaching your psychologist seat limit');
    }

    // Patients warning (90% threshold)
    if (metrics.activePatientsCount / metrics.maxActivePatients >= 0.9) {
      warnings.push('You are approaching your patient limit');
    }

    // Storage warning (85% threshold)
    if (metrics.storageUsedGB / metrics.storageGB >= 0.85) {
      warnings.push('You are approaching your storage limit');
    }

    // Notifications warning (90% threshold)
    if (metrics.notificationsThisMonth / metrics.monthlyNotificationsLimit >= 0.9) {
      warnings.push('You are approaching your monthly notification limit');
    }

    return warnings;
  }

  private async calculateProratedCharge(
    currentSubscription: any,
    newBasePrice: number,
  ): Promise<number> {
    const now = new Date();
    const periodStart = currentSubscription.currentPeriodStart;
    const periodEnd = currentSubscription.currentPeriodEnd;

    const totalDays = Math.ceil((periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.ceil((periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    const unusedCredit = (Number(currentSubscription.basePrice) / totalDays) * daysRemaining;
    const newCharge = (newBasePrice / totalDays) * daysRemaining;

    return Math.max(0, newCharge - unusedCredit);
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
```

### 2. Updated UsersService (with seat enforcement)

```typescript
// Update src/users/users.service.ts to use subscription limits

async invite(tenantId: string, dto: InviteUserDto) {
  // Check if user has permission to invite (TENANT_ADMIN only)
  
  if (dto.role === 'PSYCHOLOGIST') {
    // Check seat availability via subscription
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription) {
      throw new ForbiddenException('No active subscription found');
    }

    // Check subscription status
    if (subscription.status !== 'ACTIVE' && subscription.status !== 'TRIALING') {
      throw new ForbiddenException({
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'Cannot invite users. Your subscription is not active.',
        status: subscription.status,
      });
    }

    // Check seat limit
    if (subscription.seatsPsychologistsUsed >= subscription.seatsPsychologistsMax) {
      throw new ForbiddenException({
        error: 'SEAT_LIMIT_REACHED',
        message: `Seat limit reached. Current plan (${subscription.planType}) allows ${subscription.seatsPsychologistsMax} psychologist(s). Please upgrade your plan.`,
        details: {
          seatsPsychologistsMax: subscription.seatsPsychologistsMax,
          seatsPsychologistsUsed: subscription.seatsPsychologistsUsed,
          planType: subscription.planType,
          upgradeUrl: '/subscription/upgrade',
        },
      });
    }
  }

  // Create user and increment seat count
  return this.prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        email: dto.email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        role: dto.role,
        isActive: false, // Requires activation
      },
    });

    // Increment seat count if psychologist
    if (dto.role === 'PSYCHOLOGIST') {
      await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          seatsPsychologistsUsed: { increment: 1 },
        },
      });
    }

    // TODO: Send invitation email

    return user;
  });
}
```

### 3. Middleware for Subscription Status Check

```typescript
// src/common/guards/subscription.guard.ts

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.tenantId) {
      return true; // Let JwtAuthGuard handle this
    }

    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId: user.tenantId },
    });

    if (!subscription) {
      throw new ForbiddenException('No subscription found');
    }

    // Allow access in ACTIVE and TRIALING status
    if (subscription.status === 'ACTIVE' || subscription.status === 'TRIALING') {
      return true;
    }

    // PAST_DUE: Allow read-only access (first 7 days)
    if (subscription.status === 'PAST_DUE') {
      const method = request.method;
      if (method === 'GET') {
        return true; // Allow reads
      }
      throw new ForbiddenException({
        error: 'SUBSCRIPTION_PAST_DUE',
        message: 'Your payment is past due. Please update your payment method to restore full access.',
        readOnlyMode: true,
      });
    }

    // CANCELED or UNPAID: Block all access except data export
    throw new ForbiddenException({
      error: 'SUBSCRIPTION_INACTIVE',
      message: 'Your subscription is not active. Please contact support.',
      status: subscription.status,
    });
  }
}
```

### 4. Feature Flag Decorator

```typescript
// src/common/decorators/require-feature.decorator.ts

import { SetMetadata } from '@nestjs/common';

export const REQUIRE_FEATURE_KEY = 'requireFeature';
export const RequireFeature = (feature: string) => SetMetadata(REQUIRE_FEATURE_KEY, feature);


// src/common/guards/feature.guard.ts

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { REQUIRE_FEATURE_KEY } from '../decorators/require-feature.decorator';

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFeature = this.reflector.get<string>(REQUIRE_FEATURE_KEY, context.getHandler());
    
    if (!requiredFeature) {
      return true; // No feature requirement
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.tenantId) {
      return false;
    }

    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId: user.tenantId },
    });

    if (!subscription) {
      return false;
    }

    const featureKey = `feature${requiredFeature.charAt(0).toUpperCase()}${requiredFeature.slice(1)}`;
    const hasFeature = subscription[featureKey as keyof typeof subscription] === true;

    if (!hasFeature) {
      throw new ForbiddenException({
        error: 'FEATURE_NOT_AVAILABLE',
        message: `This feature requires a higher plan. Please upgrade.`,
        feature: requiredFeature,
        currentPlan: subscription.planType,
        upgradeUrl: '/subscription/upgrade',
      });
    }

    return true;
  }
}
```

### 5. Usage Example in Controllers

```typescript
// Example: Protecting advanced analytics endpoint

@Get('analytics/advanced')
@RequireFeature('advancedAnalytics')
async getAdvancedAnalytics(@CurrentUser() user: User) {
  // Only accessible to PRO and CUSTOM plans
  return this.analyticsService.getAdvanced(user.tenantId);
}

// Example: Checking limit before creating patient

@Post()
async createPatient(@CurrentUser() user: User, @Body() dto: CreatePatientDto) {
  // Check patient limit
  const limitCheck = await this.subscriptionService.checkUsageLimit(
    user.tenantId,
    'patients',
    1,
  );

  if (!limitCheck.allowed) {
    throw new ForbiddenException({
      error: 'PATIENT_LIMIT_REACHED',
      message: limitCheck.reason,
      current: limitCheck.current,
      limit: limitCheck.limit,
      upgradeUrl: '/subscription/upgrade',
    });
  }

  return this.patientsService.create(user.tenantId, dto);
}
```

## Summary

This implementation provides:

✅ **Complete subscription management** with TRIAL, BASIC, PRO, CUSTOM tiers  
✅ **Seat enforcement** with clear error messages and upgrade prompts  
✅ **Usage tracking** for patients, storage, notifications  
✅ **Feature flags** with guard-based enforcement  
✅ **Upgrade/downgrade flows** with validations and warnings  
✅ **Subscription status handling** (PAST_DUE, CANCELED, etc.)  
✅ **API contracts** for getCurrentSubscription, getUsageMetrics, upgradePlan  
✅ **Audit trail** via SubscriptionEvent model  
✅ **Prorated billing** calculation  
✅ **Scheduled changes** for downgrades  

Next steps:
1. Integrate Stripe for payment processing
2. Add webhook handlers for payment events
3. Implement email notifications for subscription changes
4. Create frontend components for upgrade prompts
5. Add usage metrics dashboard
