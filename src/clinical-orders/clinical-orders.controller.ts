import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { HealthSpecialtyGuard } from '../clinical-access/health-specialty.guard';
import { SignerVerificationService } from '../clinical-access/signer-verification.service';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { ClinicalFollowUpsService } from './clinical-follow-ups.service';
import { ClinicalOrdersService } from './clinical-orders.service';
import {
  AddClinicalResultDto,
  CancelClinicalOrderDto,
  ClinicalInboxQueryDto,
  CloseClinicalFollowUpDto,
  CollectSampleDto,
  CompleteClinicalOrderDto,
  CreateClinicalFollowUpDto,
  CreateClinicalOrderDto,
  ListFollowUpsQueryDto,
  RecordCommunicationDto,
  ReviewClinicalResultDto,
  SendToLabDto,
  UpdateClinicalFollowUpDto,
} from './dto/clinical-orders.dto';

/**
 * Orders, results and follow-ups are clinical content: only accounts with an active professional
 * profile of a health specialty reach them, like the rest of the clinical record.
 */
@ApiTags('clinical-orders')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.specialties')
@UseGuards(ClinicalProfileGuard, HealthSpecialtyGuard)
@Roles('MASTER', 'PROFESIONAL')
@Controller('tenants/:tenantId/patients/:patientId')
export class PatientClinicalOrdersController {
  constructor(
    private readonly orders: ClinicalOrdersService,
    private readonly followUps: ClinicalFollowUpsService,
    private readonly signer: SignerVerificationService,
  ) {}

  @Get('clinical-orders')
  @ApiOperation({ summary: 'Orders of the patient with their results and follow-ups. Audited.' })
  @RequirePermission('clinical_records.view')
  list(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.orders.list(tenantId, patientId, actor);
  }

  @Post('clinical-orders')
  @ApiOperation({
    summary: 'Order a study or procedure',
    description:
      'Inside an open encounter of the caller it is signed when the encounter closes. Without one, saving signs it and the password is required (403 SIGNATURE_PASSWORD_INVALID).',
  })
  @RequirePermission('clinical_records.create')
  async create(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CreateClinicalOrderDto,
  ) {
    if (!dto.encounterId) await this.signer.verify(actor.userId, dto.password);
    return this.orders.create(tenantId, patientId, actor, dto);
  }

  @Get('clinical-follow-ups')
  @ApiOperation({ summary: 'Follow-ups of the patient, every status. Audited.' })
  @RequirePermission('clinical_records.view')
  listFollowUps(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.followUps.listForPatient(tenantId, patientId, actor);
  }

  @Post('clinical-follow-ups')
  @ApiOperation({ summary: 'Open a follow-up that comes from no result (a preventive control)' })
  @RequirePermission('clinical_records.create')
  createFollowUp(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CreateClinicalFollowUpDto,
  ) {
    return this.followUps.create(tenantId, patientId, actor, dto);
  }
}

@ApiTags('clinical-orders')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.specialties')
@UseGuards(ClinicalProfileGuard, HealthSpecialtyGuard)
@Roles('MASTER', 'PROFESIONAL')
@Controller('tenants/:tenantId')
export class ClinicalOrdersController {
  constructor(
    private readonly orders: ClinicalOrdersService,
    private readonly followUps: ClinicalFollowUpsService,
  ) {}

  @Get('clinical-inbox')
  @ApiOperation({
    summary: 'Pending clinical work',
    description:
      'Results to review, orders without a result, reviewed results not communicated and open follow-ups, each flagged when past the clinic threshold. scope=mine (default) or all. Audited.',
  })
  @RequirePermission('clinical_records.view')
  inbox(
    @Param('tenantId') tenantId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Query() query: ClinicalInboxQueryDto,
  ) {
    return this.followUps.inbox(tenantId, actor, query);
  }

  @Get('clinical-orders/:orderId')
  @ApiOperation({ summary: 'One order with its results and follow-ups. Audited.' })
  @RequirePermission('clinical_records.view')
  findOne(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.orders.findOne(tenantId, orderId, actor);
  }

  @Post('clinical-orders/:orderId/sample')
  @ApiOperation({ summary: 'Record the sample was taken' })
  @RequirePermission('clinical_records.create')
  collectSample(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CollectSampleDto,
  ) {
    return this.orders.collectSample(tenantId, orderId, actor, dto);
  }

  @Post('clinical-orders/:orderId/sent')
  @ApiOperation({ summary: 'Record the order or sample was sent to the laboratory' })
  @RequirePermission('clinical_records.create')
  sendToLab(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: SendToLabDto,
  ) {
    return this.orders.sendToLab(tenantId, orderId, actor, dto);
  }

  @Post('clinical-orders/:orderId/results')
  @ApiOperation({
    summary: 'Record a result',
    description:
      'Each one is a new version: it waits for review (the order goes to PENDING_REVIEW) and never marks the patient as informed.',
  })
  @RequirePermission('clinical_records.create')
  addResult(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: AddClinicalResultDto,
  ) {
    return this.orders.addResult(tenantId, orderId, actor, dto);
  }

  @Post('clinical-orders/:orderId/complete')
  @ApiOperation({
    summary: 'Close the order',
    description:
      'Needs the last result reviewed and no open follow-up; without a recorded contact with the patient, a note.',
  })
  @RequirePermission('clinical_records.create')
  complete(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CompleteClinicalOrderDto,
  ) {
    return this.orders.complete(tenantId, orderId, actor, dto);
  }

  @Post('clinical-orders/:orderId/cancel')
  @ApiOperation({ summary: 'Cancel an order without result, or mark it not performed' })
  @RequirePermission('clinical_records.update')
  cancel(
    @Param('tenantId') tenantId: string,
    @Param('orderId') orderId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CancelClinicalOrderDto,
  ) {
    return this.orders.cancel(tenantId, orderId, actor, dto);
  }

  @Post('clinical-results/:resultId/review')
  @ApiOperation({
    summary: 'Review the last result of an order',
    description: 'A follow-up or a repetition opens a follow-up with a responsible and a date.',
  })
  @RequirePermission('clinical_records.create')
  review(
    @Param('tenantId') tenantId: string,
    @Param('resultId') resultId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: ReviewClinicalResultDto,
  ) {
    return this.orders.review(tenantId, resultId, actor, dto);
  }

  @Post('clinical-results/:resultId/communication')
  @ApiOperation({ summary: 'Record that the patient was told about the reviewed result' })
  @RequirePermission('clinical_records.create')
  communicate(
    @Param('tenantId') tenantId: string,
    @Param('resultId') resultId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: RecordCommunicationDto,
  ) {
    return this.orders.communicate(tenantId, resultId, actor, dto);
  }

  @Get('clinical-follow-ups')
  @ApiOperation({ summary: 'Follow-ups of the clinic or the caller, by status. Audited.' })
  @RequirePermission('clinical_records.view')
  listFollowUps(
    @Param('tenantId') tenantId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Query() query: ListFollowUpsQueryDto,
  ) {
    return this.followUps.list(tenantId, actor, query);
  }

  @Patch('clinical-follow-ups/:followUpId')
  @ApiOperation({ summary: 'Change the date, responsible or wording of an open follow-up' })
  // Editing what was written, like correcting a note or a record.
  @RequirePermission('clinical_records.update')
  updateFollowUp(
    @Param('tenantId') tenantId: string,
    @Param('followUpId') followUpId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: UpdateClinicalFollowUpDto,
  ) {
    return this.followUps.update(tenantId, followUpId, actor, dto);
  }

  @Post('clinical-follow-ups/:followUpId/close')
  @ApiOperation({ summary: 'Close a follow-up as done or cancelled, with a note' })
  @RequirePermission('clinical_records.create')
  closeFollowUp(
    @Param('tenantId') tenantId: string,
    @Param('followUpId') followUpId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CloseClinicalFollowUpDto,
  ) {
    return this.followUps.close(tenantId, followUpId, actor, dto);
  }
}
