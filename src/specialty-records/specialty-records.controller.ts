import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CreateSpecialtyRecordDto,
  DeleteSpecialtyRecordDto,
  UpdateSpecialtyRecordDto,
} from './dto/create-specialty-record.dto';
import { SpecialtyRecordsService } from './specialty-records.service';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';

@ApiTags('specialty-records')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.specialties')
@UseGuards(ClinicalProfileGuard)
@Controller('tenants/:tenantId/patients/:patientId/specialty-records')
export class SpecialtyRecordsController {
  constructor(private readonly recordsService: SpecialtyRecordsService) {}

  @Get()
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'List patient records from clinical modules and tenant forms',
    description:
      'Requires an active professional profile. Every record returned is audited and carries the alerts its data raises.',
  })
  @ApiQuery({ name: 'moduleKey', required: false })
  @RequirePermission('clinical_records.view')
  list(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Query('moduleKey') moduleKey?: string,
  ) {
    return this.recordsService.list(tenantId, patientId, actor, moduleKey);
  }

  @Get('alerts')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Clinical alerts of the patient',
    description:
      'Alerts raised by every allergy record and by the most recent record of each other module.',
  })
  @RequirePermission('clinical_records.view')
  alerts(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.recordsService.alerts(tenantId, patientId, actor);
  }

  @Get(':recordId')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({ summary: 'Get one clinical record', description: 'The read is audited.' })
  @RequirePermission('clinical_records.view')
  findOne(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('recordId') recordId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.recordsService.findOne(tenantId, patientId, recordId, actor);
  }

  @Post()
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Create a clinical record',
    description:
      'The data is validated against the module or form definition. Specialty modules can only be written by professionals of that specialty.',
  })
  @RequirePermission('clinical_records.create')
  create(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: CreateSpecialtyRecordDto,
  ) {
    return this.recordsService.create(tenantId, patientId, actor, dto);
  }

  @Patch(':recordId')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Correct a clinical record',
    description:
      'Only the author can correct a record. Requires a reason, bumps the version and keeps the previous one in the audit log.',
  })
  @RequirePermission('clinical_records.update')
  update(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('recordId') recordId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: UpdateSpecialtyRecordDto,
  ) {
    return this.recordsService.update(tenantId, patientId, recordId, actor, dto);
  }

  @Delete(':recordId')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Remove a clinical record - Author only',
    description: 'Soft delete: requires a reason and keeps the record for audit.',
  })
  @RequirePermission('clinical_records.update')
  remove(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('recordId') recordId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: DeleteSpecialtyRecordDto,
  ) {
    return this.recordsService.delete(tenantId, patientId, recordId, actor, dto);
  }
}
