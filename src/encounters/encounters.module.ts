import { Module } from '@nestjs/common';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { PatientFilesModule } from '../patient-files/patient-files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EncountersController } from './encounters.controller';
import { EncountersService } from './encounters.service';

@Module({
  // The file storage: signing hashes the bytes of files uploaded before hashes existed.
  imports: [PrismaModule, ClinicalAccessModule, PatientFilesModule],
  controllers: [EncountersController],
  providers: [EncountersService],
  exports: [EncountersService],
})
export class EncountersModule {}
