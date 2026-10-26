import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  BillableSessionsController,
  OrdersController,
  PaymentsController,
} from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';

@Module({
  imports: [PrismaModule, InventoryModule],
  controllers: [OrdersController, BillableSessionsController, PaymentsController],
  providers: [OrdersService, PaymentsService],
  exports: [OrdersService],
})
export class OrdersModule {}
