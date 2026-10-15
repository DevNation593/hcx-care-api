import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';
import { PatientsModule } from './patients/patients.module';
import { PatientTeamModule } from './patient-team/patient-team.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { ClinicalNotesModule } from './clinical-notes/clinical-notes.module';
import { ClinicalTimelineModule } from './clinical-timeline/clinical-timeline.module';
import { TasksModule } from './tasks/tasks.module';
import { NextSessionPlansModule } from './next-session-plans/next-session-plans.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { SchedulerModule } from './common/scheduler/scheduler.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { TenantSettingsModule } from './tenant-settings/tenant-settings.module';
import { SpecialtiesModule } from './specialties/specialties.module';
import { BillingModule } from './billing/billing.module';
import { SpecialtyRecordsModule } from './specialty-records/specialty-records.module';
import { ClinicalModulesModule } from './clinical-modules/clinical-modules.module';
import { BranchesModule } from './branches/branches.module';
import { EncountersModule } from './encounters/encounters.module';
import { CatalogsModule } from './catalogs/catalogs.module';
import { PatientFilesModule } from './patient-files/patient-files.module';
import { ReportsModule } from './reports/reports.module';
import { RecordDocumentsModule } from './record-documents/record-documents.module';
import { DocumentTemplatesModule } from './document-templates/document-templates.module';
import { ConsentsModule } from './consents/consents.module';
import { TreatmentsModule } from './treatments/treatments.module';
import { TreatmentSessionsModule } from './treatment-sessions/treatment-sessions.module';
import { DocumentVerificationModule } from './document-verification/document-verification.module';
import { PermissionsModule } from './common/permissions/permissions.module';
import { PlatformModule } from './platform/platform.module';
import { HealthController } from './health.controller';
import './common/utils/bigint-json';

const redisUrl = process.env.REDIS_URL;
const isRedisEnabled = Boolean(redisUrl);
const throttleTtlRaw = parseInt(process.env.THROTTLE_TTL || '60', 10);
const throttleTtlMs = throttleTtlRaw < 1000 ? throttleTtlRaw * 1000 : throttleTtlRaw;

@Module({
  controllers: [HealthController],
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Rate limiting
    ThrottlerModule.forRoot([
      {
        ttl: throttleTtlMs,
        limit: parseInt(process.env.THROTTLE_LIMIT) || 10,
      },
    ]),

    // Cron jobs. The subscription lifecycle runs here even without Redis.
    ScheduleModule.forRoot(),

    // BullMQ for background jobs (requires Redis)
    ...(isRedisEnabled
      ? [
          BullModule.forRoot({
            redis: redisUrl,
          }),
        ]
      : []),

    // Prisma database
    PrismaModule,
    PermissionsModule,

    // Scheduler for background jobs (requires Redis)
    ...(isRedisEnabled ? [SchedulerModule] : []),

    // Feature modules
    AuthModule,
    TenantsModule,
    UsersModule,
    PatientsModule,
    PatientTeamModule,
    AppointmentsModule,
    ClinicalNotesModule,
    ClinicalTimelineModule,
    TasksModule,
    NextSessionPlansModule,
    NotificationsModule,
    AuditLogModule,
    SubscriptionModule,
    TenantSettingsModule,
    SpecialtiesModule,
    BillingModule,
    SpecialtyRecordsModule,
    ClinicalModulesModule,
    BranchesModule,
    EncountersModule,
    CatalogsModule,
    PatientFilesModule,
    ReportsModule,
    RecordDocumentsModule,
    DocumentTemplatesModule,
    ConsentsModule,
    TreatmentsModule,
    TreatmentSessionsModule,
    DocumentVerificationModule,
    PlatformModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
