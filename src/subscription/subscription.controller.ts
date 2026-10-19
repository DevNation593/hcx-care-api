import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import { SubscriptionBillingService } from './subscription-billing.service';
import { AllowInactiveSubscription } from '../common/decorators/allow-inactive-subscription.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpgradePlanDto } from './dto/upgrade-plan.dto';
import { DowngradePlanDto } from './dto/downgrade-plan.dto';
import { TenantType } from '@prisma/client';

@ApiTags('Subscription')
@ApiBearerAuth()
@Controller('tenants/:tenantId/subscription')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
// A tenant whose subscription lapsed must still be able to see it and ask for a plan.
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

  @Post('upgrade')
  @Roles('MASTER')
  @ApiOperation({
    summary: 'Request a plan upgrade (Master only)',
    description: 'Creates a pending payment. The plan changes only when that payment is confirmed.',
  })
  async upgradePlan(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Body() dto: UpgradePlanDto,
  ) {
    return this.billing.requestUpgrade(tenantId, user.userId, dto.newPlan);
  }

  @Get('payments')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Payments of this subscription, pending ones included (Master only)' })
  async listPayments(@Param('tenantId') tenantId: string) {
    return this.billing.listForTenant(tenantId);
  }

  @Post('downgrade')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Schedule downgrade (Master only)' })
  async downgradePlan(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Body() dto: DowngradePlanDto,
  ) {
    return this.subscriptionService.downgradePlan(tenantId, user.userId, dto.newPlan);
  }

  @Get('plans')
  @ApiOperation({
    summary: 'Get available plans catalog with pricing and module details',
  })
  @ApiQuery({ name: 'tenantType', enum: ['PERSONAL', 'CLINIC'], required: false })
  async getAvailablePlans(@Query('tenantType') tenantType?: TenantType) {
    return this.subscriptionService.getAvailablePlans(tenantType);
  }
}
