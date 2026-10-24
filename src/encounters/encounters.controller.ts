import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CloseEncounterDto,
  DeleteEncounterDto,
  StartEncounterDto,
  UpdateEncounterDto,
} from './dto/encounter.dto';
import { EncountersService } from './encounters.service';
import { RequirePermission } from '../common/permissions/permission-catalog';

@ApiTags('encounters')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.specialties')
@UseGuards(ClinicalProfileGuard)
@Controller('tenants/:tenantId/patients/:patientId/encounters')
export class EncountersController {
  constructor(private readonly encountersService: EncountersService) {}

  @Get()
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Encounters of the patient, newest first',
    description: 'Requires an active professional profile. Every encounter returned is audited.',
  })
  @RequirePermission('clinical_records.view')
  list(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.encountersService.list(tenantId, patientId, actor);
  }

  @Post()
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Start an encounter',
    description:
      'One open encounter per professional and patient (409 ENCOUNTER_ALREADY_OPEN). With an appointment, only its professional can attend it and it is marked in progress.',
  })
  @RequirePermission('clinical_records.create')
  start(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: StartEncounterDto,
  ) {
    return this.encountersService.start(tenantId, patientId, actor, dto);
  }

  @Patch(':encounterId')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({ summary: 'Change the type or reason of an open encounter - Author only' })
  @RequirePermission('clinical_records.update')
  update(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('encounterId') encounterId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: UpdateEncounterDto,
  ) {
    return this.encountersService.update(tenantId, patientId, encounterId, actor, dto);
  }

  @Post(':encounterId/close')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Close an encounter - Author only',
    description:
      'The sign-off of the professional: the encounter takes no more records and its appointment is completed.',
  })
  @RequirePermission('clinical_records.update')
  close(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('encounterId') encounterId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CloseEncounterDto,
  ) {
    return this.encountersService.close(tenantId, patientId, encounterId, actor, dto);
  }

  @Delete(':encounterId')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Remove an encounter without records - Author only',
    description: 'Soft delete: requires a reason and keeps the encounter for audit.',
  })
  @RequirePermission('clinical_records.update')
  remove(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('encounterId') encounterId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: DeleteEncounterDto,
  ) {
    return this.encountersService.delete(tenantId, patientId, encounterId, actor, dto);
  }
}
