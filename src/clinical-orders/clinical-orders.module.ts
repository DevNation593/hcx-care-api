import { Module } from '@nestjs/common';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { ClinicalFollowUpsService } from './clinical-follow-ups.service';
import {
  ClinicalOrdersController,
  PatientClinicalOrdersController,
} from './clinical-orders.controller';
import { ClinicalOrdersService } from './clinical-orders.service';

@Module({
  imports: [ClinicalAccessModule],
  controllers: [PatientClinicalOrdersController, ClinicalOrdersController],
  providers: [ClinicalOrdersService, ClinicalFollowUpsService],
})
export class ClinicalOrdersModule {}
