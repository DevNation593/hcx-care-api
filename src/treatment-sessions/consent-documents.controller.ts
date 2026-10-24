import { Body, Controller, Get, Param, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { ConsentDocumentsService } from './consent-documents.service';
import { ConsentReasonDto, SignConsentDto } from './dto/consent-document.dto';

@ApiTags('treatment-sessions')
@ApiBearerAuth('access-token')
@RequireSection('core.treatments.sessions')
@Controller('tenants/:tenantId/consent-documents')
export class ConsentDocumentsController {
  constructor(private readonly consentsService: ConsentDocumentsService) {}

  @Post(':id/sign')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.create')
  @ApiOperation({
    summary: 'Sign a presented consent - Professional of the session only',
    description:
      'The signing time is the server time. Stores the signature and an encrypted PDF and moves the session to CONSENTED. 409 CONSENT_DOCUMENT_INVALID_STATE unless PRESENTED, 422 CONSENT_DECLARATIONS_REQUIRED or CONSENT_REPRESENTATIVE_REQUIRED, 400 CONSENT_SIGNATURE_INVALID or CONSENT_RELATIONSHIP_REQUIRED.',
  })
  sign(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: SignConsentDto,
  ) {
    return this.consentsService.sign(tenantId, id, actor, dto);
  }

  @Post(':id/refuse')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.update')
  @ApiOperation({
    summary:
      'Record that the patient refused a presented consent - Professional of the session only',
    description:
      'The session ends as CONSENT_REFUSED and its encounter is closed. 409 CONSENT_DOCUMENT_INVALID_STATE unless PRESENTED.',
  })
  refuse(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: ConsentReasonDto,
  ) {
    return this.consentsService.refuse(tenantId, id, actor, dto);
  }

  @Post(':id/revoke')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.update')
  @ApiOperation({
    summary: 'Revoke a signed consent - Professional of the session or account holder',
    description:
      'A CONSENTED session ends as CONSENT_REVOKED and its encounter is closed; a session in any other state is left as it is. Other sessions that reused it and are still CONSENTED go back to READY_FOR_CONSENT. 409 CONSENT_DOCUMENT_INVALID_STATE unless SIGNED.',
  })
  revoke(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: ConsentReasonDto,
  ) {
    return this.consentsService.revoke(tenantId, id, actor, dto);
  }

  @Get(':id/pdf')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.view')
  @ApiOperation({
    summary: 'Download the signed consent PDF',
    description:
      'Checked against the SHA-256 kept on signing (500 CONSENT_PDF_INTEGRITY). The download is audited.',
  })
  async pdf(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    const file = await this.consentsService.pdf(tenantId, id, actor);
    return new StreamableFile(file.data, {
      type: 'application/pdf',
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.data.length,
    });
  }
}
