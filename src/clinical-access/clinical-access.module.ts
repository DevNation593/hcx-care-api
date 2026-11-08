import { Module } from '@nestjs/common';
import { ClinicalAuditService } from './clinical-audit.service';
import { ClinicalCryptoService } from './clinical-crypto.service';
import { ClinicalProfileGuard } from './clinical-profile.guard';
import { HealthSpecialtyGuard } from './health-specialty.guard';
import { SignerVerificationService } from './signer-verification.service';

@Module({
  providers: [
    ClinicalAuditService,
    ClinicalCryptoService,
    ClinicalProfileGuard,
    HealthSpecialtyGuard,
    SignerVerificationService,
  ],
  exports: [
    ClinicalAuditService,
    ClinicalCryptoService,
    ClinicalProfileGuard,
    HealthSpecialtyGuard,
    SignerVerificationService,
  ],
})
export class ClinicalAccessModule {}
