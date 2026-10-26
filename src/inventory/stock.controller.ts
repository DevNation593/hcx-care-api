import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { CreateStockReceiptDto, ListStockReceiptsQuery } from './dto/stock-receipt.dto';
import { StockReceiptsService } from './stock-receipts.service';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.inventory')
@Controller('tenants/:tenantId')
export class StockController {
  constructor(private readonly receipts: StockReceiptsService) {}

  @Post('stock-receipts')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({
    summary: 'Receive purchased stock: one lot per line',
    description:
      '400 BRANCH_NOT_AVAILABLE, 404 PRODUCT_NOT_FOUND, 409 PRODUCT_INACTIVE, 422 LOT_EXPIRY_REQUIRED, LOT_ALREADY_EXPIRED.',
  })
  createReceipt(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStockReceiptDto,
  ) {
    return this.receipts.create(tenantId, user.userId, dto);
  }

  @Get('stock-receipts')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Stock receipts, newest first' })
  listReceipts(@Param('tenantId') tenantId: string, @Query() query: ListStockReceiptsQuery) {
    return this.receipts.list(tenantId, query);
  }

  @Get('stock-receipts/:id')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'A stock receipt with its lines' })
  getReceipt(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.receipts.get(tenantId, id);
  }
}
