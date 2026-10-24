import { Module } from '@nestjs/common';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { NextSessionPlansService } from './next-session-plans.service';
import { NextSessionPlansController } from './next-session-plans.controller';

@Module({
  imports: [ClinicalAccessModule],
  controllers: [NextSessionPlansController],
  providers: [NextSessionPlansService],
  exports: [NextSessionPlansService],
})
export class NextSessionPlansModule {}
