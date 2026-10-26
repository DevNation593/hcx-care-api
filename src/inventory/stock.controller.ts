import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { CreateStockAdjustmentDto } from './dto/stock-adjustment.dto';
import { CreateStockReceiptDto, ListStockReceiptsQuery } from './dto/stock-receipt.dto';
import {
  CreateStockTransferDto,
  ListStockMovementsQuery,
  ListStockTransfersQuery,
} from './dto/stock-transfer.dto';
import { StockAdjustmentsService } from './stock-adjustments.service';
import { StockMovementsService } from './stock-movements.service';
import { StockReceiptsService } from './stock-receipts.service';
import { StockTransfersService } from './stock-transfers.service';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.inventory')
@Controller('tenants/:tenantId')
export class StockController {
  constructor(
    private readonly receipts: StockReceiptsService,
    private readonly adjustments: StockAdjustmentsService,
    private readonly transfers: StockTransfersService,
    private readonly movements: StockMovementsService,
  ) {}

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

  @Post('stock-lots/:id/adjustments')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({
    summary: 'Adjust the balance of a lot by a delta or to a counted quantity',
    description:
      '404 STOCK_LOT_NOT_FOUND, 422 ADJUSTMENT_EMPTY, ADJUSTMENT_NOTE_REQUIRED, STOCK_BELOW_ZERO.',
  })
  adjustLot(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStockAdjustmentDto,
  ) {
    return this.adjustments.adjust(tenantId, user.userId, id, dto);
  }

  @Post('stock-transfers')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({
    summary: 'Move lots between two branches, immediately',
    description:
      '400 BRANCH_NOT_AVAILABLE, 404 STOCK_LOT_NOT_FOUND, 409 INSUFFICIENT_STOCK, 422 TRANSFER_SAME_BRANCH, LOT_NOT_IN_BRANCH.',
  })
  createTransfer(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStockTransferDto,
  ) {
    return this.transfers.create(tenantId, user.userId, dto);
  }

  @Get('stock-transfers')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Stock transfers, newest first' })
  listTransfers(@Param('tenantId') tenantId: string, @Query() query: ListStockTransfersQuery) {
    return this.transfers.list(tenantId, query);
  }

  @Get('stock-transfers/:id')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'A stock transfer with its lines' })
  getTransfer(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.transfers.get(tenantId, id);
  }

  @Get('stock-movements')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Stock movements, newest first' })
  listMovements(@Param('tenantId') tenantId: string, @Query() query: ListStockMovementsQuery) {
    return this.movements.list(tenantId, query);
  }
}
