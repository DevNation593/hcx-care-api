import { Module } from '@nestjs/common';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { PatientFilesModule } from '../patient-files/patient-files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProcedureConsentsController } from './procedure-consents.controller';
import { ProcedureConsentsService } from './procedure-consents.service';

@Module({
  imports: [PrismaModule, ClinicalAccessModule, PatientFilesModule],
  controllers: [ProcedureConsentsController],
  providers: [ProcedureConsentsService],
})
export class ProcedureConsentsModule {}
