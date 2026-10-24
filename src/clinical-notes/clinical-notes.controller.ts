import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ClinicalNotesService } from './clinical-notes.service';
import {
  CreateClinicalNoteDto,
  DeleteClinicalNoteDto,
  UpdateClinicalNoteDto,
} from './dto/clinical-note.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { HealthSpecialtyGuard } from '../clinical-access/health-specialty.guard';
import { RequirePermission } from '../common/permissions/permission-catalog';

@ApiTags('clinical-notes')
@ApiBearerAuth('access-token')
@RequireSection('core.clinicalNotes')
@UseGuards(ClinicalProfileGuard)
@Controller('tenants/:tenantId/clinical-notes')
export class ClinicalNotesController {
  constructor(private readonly clinicalNotesService: ClinicalNotesService) {}

  @Roles('PROFESIONAL')
  @Post()
  @ApiOperation({
    summary: 'Create clinical note - Professional only',
    description: 'Creates audit log entry automatically',
  })
  @ApiResponse({ status: 201, description: 'Clinical note created' })
  @RequirePermission('clinical_records.create')
  @UseGuards(HealthSpecialtyGuard)
  async create(
    @Param('tenantId') tenantId: string,
    @Body() createDto: CreateClinicalNoteDto,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.clinicalNotesService.create(tenantId, actor, createDto);
  }

  @Roles('MASTER', 'PROFESIONAL')
  @Get()
  @ApiOperation({
    summary: 'List clinical notes with filters',
    description: 'Requires an active professional profile. Every note returned is audited.',
  })
  @ApiQuery({ name: 'patientId', required: false })
  @ApiQuery({ name: 'psychologistId', required: false })
  @ApiResponse({ status: 200, description: 'Clinical notes list' })
  @RequirePermission('clinical_records.view')
  async findAll(
    @Param('tenantId') tenantId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Query('patientId') patientId?: string,
    @Query('psychologistId') psychologistId?: string,
  ) {
    return this.clinicalNotesService.findAll(tenantId, actor, { patientId, psychologistId });
  }

  @Roles('MASTER', 'PROFESIONAL')
  @Get(':noteId')
  @ApiOperation({
    summary: 'Get clinical note - Restricted access',
    description: 'Requires an active professional profile. Creates audit log entry.',
  })
  @ApiResponse({ status: 200, description: 'Clinical note found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @RequirePermission('clinical_records.view')
  async findOne(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.clinicalNotesService.findOne(tenantId, noteId, actor);
  }

  @Roles('PROFESIONAL')
  @Patch(':noteId')
  @ApiOperation({
    summary: 'Correct clinical note',
    description:
      'Only the author can correct a note. Requires a reason, bumps the version and keeps the previous one in the audit log.',
  })
  @ApiResponse({ status: 200, description: 'Clinical note updated' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  @RequirePermission('clinical_records.update')
  async update(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @Body() updateDto: UpdateClinicalNoteDto,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.clinicalNotesService.update(tenantId, noteId, actor, updateDto);
  }

  @Roles('MASTER', 'PROFESIONAL')
  @Delete(':noteId')
  @ApiOperation({
    summary: 'Remove clinical note - Author only',
    description:
      'Soft delete: requires a reason and keeps the note for audit. Creates audit log entry.',
  })
  @ApiResponse({ status: 200, description: 'Clinical note deleted' })
  @RequirePermission('clinical_records.update')
  async remove(
    @Param('tenantId') tenantId: string,
    @Param('noteId') noteId: string,
    @Body() deleteDto: DeleteClinicalNoteDto,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.clinicalNotesService.delete(tenantId, noteId, actor, deleteDto);
  }
}
