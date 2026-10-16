import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OrdersController, PaymentsController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';

@Module({
  imports: [PrismaModule],
  controllers: [OrdersController, PaymentsController],
  providers: [OrdersService, PaymentsService],
  exports: [OrdersService],
})
export class OrdersModule {}
