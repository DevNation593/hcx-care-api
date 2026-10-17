import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CashRegistersController } from './cash-registers.controller';
import { CashRegistersService } from './cash-registers.service';

@Module({
  imports: [PrismaModule],
  controllers: [CashRegistersController],
  providers: [CashRegistersService],
  exports: [CashRegistersService],
})
export class CashRegistersModule {}
