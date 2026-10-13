import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FILE_STORAGE } from './file-storage';
import { createFileStorage } from './file-storage.factory';
import { PatientFilesController, StorageController } from './patient-files.controller';
import { PatientFilesService } from './patient-files.service';

@Module({
  imports: [PrismaModule, ClinicalAccessModule],
  controllers: [PatientFilesController, StorageController],
  providers: [
    PatientFilesService,
    { provide: FILE_STORAGE, useFactory: createFileStorage, inject: [ConfigService] },
  ],
  exports: [PatientFilesService],
})
export class PatientFilesModule {}
