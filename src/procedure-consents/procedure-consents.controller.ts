import { Body, Controller, Get, Param, Post, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { HealthSpecialtyGuard } from '../clinical-access/health-specialty.guard';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { ConsentReasonDto } from '../treatment-sessions/dto/consent-document.dto';
import { PresentProcedureConsentDto, SignProcedureConsentDto } from './dto/procedure-consent.dto';
import { ProcedureConsentsService } from './procedure-consents.service';

/**
 * Consents of clinical procedures, taken in an encounter. They are clinical content: an active
 * professional profile of a health specialty, like the rest of the clinical record.
 */
@ApiTags('procedure-consents')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.specialties')
@UseGuards(ClinicalProfileGuard, HealthSpecialtyGuard)
@Roles('MASTER', 'PROFESIONAL')
@Controller('tenants/:tenantId')
export class ProcedureConsentsController {
  constructor(private readonly consents: ProcedureConsentsService) {}

  @Get('procedure-consents/templates')
  @ApiOperation({ summary: 'Consent templates of the clinic with a published version' })
  @RequirePermission('clinical_records.view')
  templates(@Param('tenantId') tenantId: string) {
    return this.consents.templates(tenantId);
  }

  @Get('patients/:patientId/procedure-consents')
  @ApiOperation({ summary: 'Procedure consents of the patient, with their events. Audited.' })
  @RequirePermission('clinical_records.view')
  list(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.consents.list(tenantId, patientId, actor);
  }

  @Post('patients/:patientId/encounters/:encounterId/procedure-consents')
  @ApiOperation({
    summary: 'Present a consent for a procedure in an open encounter of the caller',
    description:
      'Uses the latest published version of the template. Returns the text to read with the patient.',
  })
  @RequirePermission('clinical_records.create')
  present(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('encounterId') encounterId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: PresentProcedureConsentDto,
  ) {
    return this.consents.present(tenantId, patientId, encounterId, actor, dto);
  }

  // Declared after `procedure-consents/templates`, which therefore keeps its own route.
  @Get('procedure-consents/:id')
  @ApiOperation({
    summary: 'One procedure consent with its text',
    description: 'To take up a presented consent that was not signed nor refused. Audited.',
  })
  @RequirePermission('clinical_records.view')
  findOne(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.consents.findOne(tenantId, id, actor);
  }

  @Post('procedure-consents/:id/sign')
  @ApiOperation({
    summary: 'Sign a presented procedure consent',
    description: 'The professional of the encounter records the signature drawn on screen.',
  })
  @RequirePermission('clinical_records.create')
  sign(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: SignProcedureConsentDto,
  ) {
    return this.consents.sign(tenantId, id, actor, dto);
  }

  @Post('procedure-consents/:id/refuse')
  @ApiOperation({ summary: 'Record that the consent was refused, with the reason' })
  @RequirePermission('clinical_records.update')
  refuse(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: ConsentReasonDto,
  ) {
    return this.consents.refuse(tenantId, id, actor, dto);
  }

  @Post('procedure-consents/:id/revoke')
  @ApiOperation({ summary: 'Revoke a signed procedure consent, with the reason' })
  @RequirePermission('clinical_records.update')
  revoke(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: ConsentReasonDto,
  ) {
    return this.consents.revoke(tenantId, id, actor, dto);
  }

  @Get('procedure-consents/:id/pdf')
  @ApiOperation({
    summary: 'Download the signed procedure consent PDF',
    description:
      'Checked against the SHA-256 kept on signing (500 CONSENT_PDF_INTEGRITY). The download is audited.',
  })
  @RequirePermission('clinical_records.view')
  async pdf(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    const file = await this.consents.pdf(tenantId, id, actor);
    return new StreamableFile(file.data, {
      type: 'application/pdf',
      disposition: `attachment; filename="${file.fileName}"`,
      length: file.data.length,
    });
  }
}
