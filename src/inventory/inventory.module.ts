import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StockController } from './stock.controller';
import { StockReceiptsService } from './stock-receipts.service';
import { StockAllocationService } from './stock-allocation.service';

@Module({
  imports: [PrismaModule],
  controllers: [ProductsController, StockController],
  providers: [ProductsService, StockAllocationService, StockReceiptsService],
  exports: [ProductsService, StockAllocationService],
})
export class InventoryModule {}
