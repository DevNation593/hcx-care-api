import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { RequireFeature } from '../common/decorators/require-feature.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { RecordDocumentsService } from './record-documents.service';

@ApiTags('specialty-records')
@ApiBearerAuth('access-token')
@RequireSection('core.patients.files')
@UseGuards(ClinicalProfileGuard)
@Controller('tenants/:tenantId/patients/:patientId/specialty-records/:recordId/document')
export class RecordDocumentsController {
  constructor(private readonly documentsService: RecordDocumentsService) {}

  @Post()
  @Roles('MASTER', 'PROFESIONAL')
  @RequireFeature('attachments')
  @RequirePermission('clinical_records.create')
  @ApiOperation({
    summary: 'Save the record as a PDF among the files of the patient',
    description:
      'Renders the record with the letterhead of the clinic, the signature block of its author and a QR with its verification code, and stores it as a patient file. Returns the file.',
  })
  issue(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('recordId') recordId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.documentsService.issue(tenantId, patientId, recordId, actor);
  }
}
