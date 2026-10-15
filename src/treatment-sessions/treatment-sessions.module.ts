import { Module } from '@nestjs/common';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { EncountersModule } from '../encounters/encounters.module';
import { PatientFilesModule } from '../patient-files/patient-files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SpecialtyRecordsModule } from '../specialty-records/specialty-records.module';
import { TreatmentsModule } from '../treatments/treatments.module';
import { ConsentDocumentsController } from './consent-documents.controller';
import { ConsentDocumentsService } from './consent-documents.service';
import { SessionMediaService } from './session-media.service';
import { TreatmentSessionsController } from './treatment-sessions.controller';
import { TreatmentSessionsService } from './treatment-sessions.service';

@Module({
  imports: [
    PrismaModule,
    ClinicalAccessModule,
    TreatmentsModule,
    EncountersModule,
    SpecialtyRecordsModule,
    PatientFilesModule,
  ],
  controllers: [TreatmentSessionsController, ConsentDocumentsController],
  providers: [TreatmentSessionsService, ConsentDocumentsService, SessionMediaService],
  exports: [TreatmentSessionsService],
})
export class TreatmentSessionsModule {}
