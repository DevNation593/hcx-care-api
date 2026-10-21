import { Module } from '@nestjs/common';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { PatientFilesModule } from '../patient-files/patient-files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AestheticPhotosService } from './aesthetic-photos.service';
import { AestheticsController } from './aesthetics.controller';
import { AestheticsService } from './aesthetics.service';

@Module({
  imports: [PrismaModule, ClinicalAccessModule, PatientFilesModule],
  controllers: [AestheticsController],
  providers: [AestheticsService, AestheticPhotosService],
})
export class AestheticsModule {}
