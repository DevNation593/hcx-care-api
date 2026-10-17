import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { MAX_PATIENT_FILE_BYTES, UploadedFilePart } from '../patient-files/patient-files.service';
import { ConsentDocumentsService } from './consent-documents.service';
import {
  CancelTreatmentSessionDto,
  CompleteTreatmentSessionDto,
  CreateTreatmentSessionDto,
  SaveSessionFormDto,
  UploadSessionMediaDto,
} from './dto/treatment-session.dto';
import { SessionMediaService } from './session-media.service';
import { TreatmentSessionsService } from './treatment-sessions.service';

@ApiTags('treatment-sessions')
@ApiBearerAuth('access-token')
@RequireSection('core.specialties')
@Controller('tenants/:tenantId')
export class TreatmentSessionsController {
  constructor(
    private readonly sessionsService: TreatmentSessionsService,
    private readonly consentsService: ConsentDocumentsService,
    private readonly mediaService: SessionMediaService,
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

  @Post('treatment-sessions/:id/media')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PATIENT_FILE_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Add a photo or file to the session - Its professional only',
    description:
      'BEFORE once the consent is satisfied and before the start, AFTER while in progress, OTHER until the session ends (409 SESSION_PHOTO_PHASE_NOT_ALLOWED). BEFORE and AFTER take JPG or PNG only; JPGs lose their EXIF/XMP segments (400 PATIENT_FILE_INVALID). Stored encrypted as a clinical file of the patient.',
  })
  uploadMedia(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @UploadedFile() file: UploadedFilePart | undefined,
    @Body() dto: UploadSessionMediaDto,
  ) {
    return this.mediaService.upload(tenantId, id, actor, file, dto);
  }

  @Post('treatment-sessions/:id/start')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.create')
  @ApiOperation({
    summary: 'Start the procedure - Its professional only',
    description:
      'The start time is the server time. 422 TREATMENT_REQUIREMENTS_MISSING with missing when the form, consent or before photos are not there; 409 TREATMENT_SESSION_INVALID_TRANSITION from any other state than CONSENTED (or READY_FOR_CONSENT without consent).',
  })
  start(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.sessionsService.start(tenantId, id, actor);
  }

  @Post('treatment-sessions/:id/complete')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.create')
  @ApiOperation({
    summary: 'Complete the procedure - Its professional only',
    description:
      'Stores the procedure notes encrypted and closes the encounter with them as summary. 422 TREATMENT_REQUIREMENTS_MISSING with missing when the notes or after photos are not there; 409 TREATMENT_SESSION_INVALID_TRANSITION unless IN_PROGRESS.',
  })
  complete(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CompleteTreatmentSessionDto,
  ) {
    return this.sessionsService.complete(tenantId, id, actor, dto);
  }

  @Post('treatment-sessions/:id/cancel')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.update')
  @ApiOperation({
    summary: 'Cancel the session - Its professional only',
    description:
      'Requires a reason, stored encrypted; closes the encounter. 409 TREATMENT_SESSION_INVALID_TRANSITION once the session has ended.',
  })
  cancel(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CancelTreatmentSessionDto,
  ) {
    return this.sessionsService.cancel(tenantId, id, actor, dto);
  }

  @Post('treatment-sessions/:id/no-show')
  @UseGuards(ClinicalProfileGuard)
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.update')
  @ApiOperation({
    summary: 'Record that the patient did not come - Its professional only',
    description:
      'The session and its appointment end as NO_SHOW and the encounter closes. 409 TREATMENT_SESSION_INVALID_TRANSITION once the procedure has started or the session has ended.',
  })
  noShow(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.sessionsService.noShow(tenantId, id, actor);
  }

  @Get('treatment-sessions/:id/compliance')
  @Roles('MASTER')
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
