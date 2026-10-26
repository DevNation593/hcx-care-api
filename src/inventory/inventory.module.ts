import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StockController } from './stock.controller';
import { InventoryReportsController } from './inventory-reports.controller';
import { InventoryReportsService } from './inventory-reports.service';
import { StockReceiptsService } from './stock-receipts.service';
import { StockAdjustmentsService } from './stock-adjustments.service';
import { StockMovementsService } from './stock-movements.service';
import { StockTransfersService } from './stock-transfers.service';
import { StockAllocationService } from './stock-allocation.service';

@Module({
  imports: [PrismaModule],
  controllers: [ProductsController, StockController, InventoryReportsController],
  providers: [
    InventoryReportsService,
    ProductsService,
    StockAllocationService,
    StockReceiptsService,
    StockAdjustmentsService,
    StockTransfersService,
    StockMovementsService,
  ],
  exports: [ProductsService, StockAllocationService],
})
export class InventoryModule {}
