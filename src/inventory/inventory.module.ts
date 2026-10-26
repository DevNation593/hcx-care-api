import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { StockAllocationService } from './stock-allocation.service';

@Module({
  imports: [PrismaModule],
  controllers: [ProductsController],
  providers: [ProductsService, StockAllocationService],
  exports: [ProductsService, StockAllocationService],
})
export class InventoryModule {}
