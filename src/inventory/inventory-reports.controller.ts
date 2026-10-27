import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import {
  BranchReportQuery,
  ExpiringReportQuery,
  MarginReportQuery,
} from './dto/inventory-reports.dto';
import { InventoryReportsService } from './inventory-reports.service';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.inventory')
@Controller('tenants/:tenantId/inventory/reports')
export class InventoryReportsController {
  constructor(private readonly reports: InventoryReportsService) {}

  @Get('valuation')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Stock value per branch and product, expired lots included' })
  valuation(@Param('tenantId') tenantId: string, @Query() query: BranchReportQuery) {
    return this.reports.valuation(tenantId, query);
  }

  @Get('expiring')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Lots already expired and lots expiring within 30, 60 or 90 days' })
  expiring(@Param('tenantId') tenantId: string, @Query() query: ExpiringReportQuery) {
    return this.reports.expiring(tenantId, query);
  }

  @Get('low-stock')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Products below their minimum stock, per branch' })
  lowStock(@Param('tenantId') tenantId: string, @Query() query: BranchReportQuery) {
    return this.reports.lowStock(tenantId, query);
  }

  @Get('margin')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({
    summary: 'Net sales, lot cost and margin of product lines in paid orders',
    description: '422 REPORT_RANGE_TOO_LONG when the period exceeds 366 days.',
  })
  margin(@Param('tenantId') tenantId: string, @Query() query: MarginReportQuery) {
    return this.reports.margin(tenantId, query);
  }
}
