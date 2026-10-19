import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SpecialtiesModule } from '../specialties/specialties.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { UsersModule } from '../users/users.module';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformLegacyAccessController } from './platform-legacy-access.controller';
import { PlatformPaymentsController } from './platform-payments.controller';
import { PlatformRolePermissionsService } from './platform-role-permissions.service';
import { PlatformSubscriptionService } from './platform-subscription.service';
import { PlatformSummaryController } from './platform-summary.controller';
import { PlatformSummaryService } from './platform-summary.service';
import { PlatformTenantsController } from './platform-tenants.controller';
import { PlatformTenantsService } from './platform-tenants.service';

@Module({
  imports: [PrismaModule, AuthModule, SpecialtiesModule, SubscriptionModule, UsersModule],
  controllers: [
    PlatformTenantsController,
    PlatformSummaryController,
    PlatformPaymentsController,
    PlatformLegacyAccessController,
  ],
  providers: [
    PlatformTenantsService,
    PlatformSubscriptionService,
    PlatformAuditService,
    PlatformSummaryService,
    PlatformRolePermissionsService,
  ],
  exports: [PlatformTenantsService, PlatformAuditService],
})
export class PlatformModule {}
