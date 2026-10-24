import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import { AllowInactiveSubscription } from '../common/decorators/allow-inactive-subscription.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('Subscription')
@ApiBearerAuth()
@Controller('tenants/:tenantId/subscription')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
// A tenant whose subscription lapsed must still be able to see it. Only the platform changes the plan.
@AllowInactiveSubscription()
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly billing: SubscriptionBillingService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get current subscription details' })
  async getCurrentSubscription(@Param('tenantId') tenantId: string) {
    return this.subscriptionService.getCurrentSubscription(tenantId);
  }

  @Get('usage')
  @ApiOperation({ summary: 'Get usage metrics and limits' })
  async getUsageMetrics(@Param('tenantId') tenantId: string) {
    return this.subscriptionService.getUsageMetrics(tenantId);
  }

  @Get('payments')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Payments of this subscription, pending ones included (Master only)' })
  async listPayments(@Param('tenantId') tenantId: string) {
    return this.billing.listForTenant(tenantId);
  }
}
