import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';

@ApiTags('billing')
@ApiBearerAuth('access-token')
@RequireSection('core.billing')
@Controller('tenants/:tenantId/billing')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('invoices')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Emitir factura electrónica mediante Faktur' })
  @RequirePermission('billing.create')
  createInvoice(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.billingService.createInvoice(tenantId, user.userId, dto);
  }

  @Get('invoices')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Listar facturas del tenant' })
  @ApiQuery({ name: 'patientId', required: false })
  @RequirePermission('billing.view')
  listInvoices(@Param('tenantId') tenantId: string, @Query('patientId') patientId?: string) {
    return this.billingService.listInvoices(tenantId, { patientId });
  }

  @Get('invoices/:invoiceId')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Consultar una factura' })
  @RequirePermission('billing.view')
  getInvoice(@Param('tenantId') tenantId: string, @Param('invoiceId') invoiceId: string) {
    return this.billingService.getInvoice(tenantId, invoiceId);
  }
}
