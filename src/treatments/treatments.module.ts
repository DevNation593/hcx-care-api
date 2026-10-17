import { Module } from '@nestjs/common';
import { ConsentsModule } from '../consents/consents.module';
import { PrismaModule } from '../prisma/prisma.module';
import { TreatmentsController } from './treatments.controller';
import { TreatmentsService } from './treatments.service';

@Module({
  imports: [PrismaModule, ConsentsModule],
  controllers: [TreatmentsController],
  providers: [TreatmentsService],
  exports: [TreatmentsService],
})
export class TreatmentsModule {}
