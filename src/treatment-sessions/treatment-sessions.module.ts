import { Module } from '@nestjs/common';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { EncountersModule } from '../encounters/encounters.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SpecialtyRecordsModule } from '../specialty-records/specialty-records.module';
import { TreatmentsModule } from '../treatments/treatments.module';
import { TreatmentSessionsController } from './treatment-sessions.controller';
import { TreatmentSessionsService } from './treatment-sessions.service';

@Module({
  imports: [
    PrismaModule,
    ClinicalAccessModule,
    TreatmentsModule,
    EncountersModule,
    SpecialtyRecordsModule,
  ],
  controllers: [TreatmentSessionsController],
  providers: [TreatmentSessionsService],
  exports: [TreatmentSessionsService],
})
export class TreatmentSessionsModule {}
