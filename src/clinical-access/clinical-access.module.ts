import { Module } from '@nestjs/common';
import { ClinicalAuditService } from './clinical-audit.service';
import { ClinicalCryptoService } from './clinical-crypto.service';
import { ClinicalProfileGuard } from './clinical-profile.guard';
import { HealthSpecialtyGuard } from './health-specialty.guard';

@Module({
  providers: [
    ClinicalAuditService,
    ClinicalCryptoService,
    ClinicalProfileGuard,
    HealthSpecialtyGuard,
  ],
  exports: [
    ClinicalAuditService,
    ClinicalCryptoService,
    ClinicalProfileGuard,
    HealthSpecialtyGuard,
  ],
})
export class ClinicalAccessModule {}
