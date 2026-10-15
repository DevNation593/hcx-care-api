import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { ConsentDocumentsService } from './consent-documents.service';
import { CreateTreatmentSessionDto, SaveSessionFormDto } from './dto/treatment-session.dto';
import { TreatmentSessionsService } from './treatment-sessions.service';

@ApiTags('treatment-sessions')
@ApiBearerAuth('access-token')
@RequireSection('core.specialties')
@Controller('tenants/:tenantId')
export class TreatmentSessionsController {
  constructor(
    private readonly sessionsService: TreatmentSessionsService,
    private readonly consentsService: ConsentDocumentsService,
  ) {}

  @Get('patients/:patientId/treatment-sessions')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.view')
  @ApiOperation({
    summary: 'Treatment sessions of the patient, newest first',
    description: 'Requires an active professional profile. Every session listed is audited.',
  })
  list(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.sessionsService.list(tenantId, patientId, actor);
  }

  @Post('patients/:patientId/treatment-sessions')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.create')
  @ApiOperation({
    summary: 'Open a treatment session',
    description:
      'Pins the current version of the treatment and opens a PROCEDURE encounter. 403 TREATMENT_SPECIALTY_MISMATCH, 404 TREATMENT_NOT_FOUND, 409 TREATMENT_INACTIVE or ENCOUNTER_ALREADY_OPEN.',
  })
  create(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CreateTreatmentSessionDto,
  ) {
    return this.sessionsService.create(tenantId, patientId, actor, dto);
  }

  @Get('treatment-sessions/:id')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.view')
  @ApiOperation({
    summary: 'A treatment session',
    description:
      'With its policy, form, consents (without body), photos, requirements { start, complete } and allowed commands. Audited.',
  })
  get(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.sessionsService.get(tenantId, id, actor);
  }

  @Put('treatment-sessions/:id/form')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.create')
  @ApiOperation({
    summary: 'Save or correct the medical form of the session - Its professional only',
    description:
      'Validated whole against the form version the treatment pins (422 CLINICAL_RECORD_INVALID). 409 TREATMENT_SESSION_INVALID_TRANSITION once the session has started or when the treatment requires no form.',
  })
  saveForm(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: SaveSessionFormDto,
  ) {
    return this.sessionsService.saveForm(tenantId, id, actor, dto);
  }

  @Post('treatment-sessions/:id/consents')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.create')
  @ApiOperation({
    summary: 'Present the consent the treatment requires - Its professional only',
    description:
      'Renders the pinned consent template version with the patient, treatment, professional and date. Returns the document already presented, if any. Includes the title and body. 409 CONSENT_NOT_REQUIRED when the treatment requires none, 409 TREATMENT_SESSION_INVALID_TRANSITION when the session does not take a consent now.',
  })
  presentConsent(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.consentsService.present(tenantId, id, actor);
  }

  @Get('treatment-sessions/:id/compliance')
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('billing.view')
  @ApiOperation({
    summary: 'Whether the session meets its treatment requirements',
    description:
      'Only { status, missing }, without clinical content: what is missing to start until the session has started, and to complete it afterwards.',
  })
  compliance(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.sessionsService.compliance(tenantId, id);
  }
}
