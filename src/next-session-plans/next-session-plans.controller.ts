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
import { HealthSpecialtyGuard } from '../clinical-access/health-specialty.guard';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { NextSessionPlansService } from './next-session-plans.service';
import { CreateNextSessionPlanDto, UpdateNextSessionPlanDto } from './dto/next-session-plan.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';

@ApiTags('next-session-plans')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.nextSession')
@Controller('tenants/:tenantId/next-session-plans')
export class NextSessionPlansController {
  constructor(private readonly nextSessionPlansService: NextSessionPlansService) {}

  @Roles('PROFESIONAL')
  @Post()
  @ApiOperation({ summary: 'Create next session plan for patient' })
  @ApiResponse({ status: 201, description: 'Plan created' })
  @ApiResponse({ status: 409, description: 'Plan already exists for this patient' })
  @RequirePermission('clinical_records.create')
  @UseGuards(HealthSpecialtyGuard)
  async create(
    @Param('tenantId') tenantId: string,
    @Body() createDto: CreateNextSessionPlanDto,
    @CurrentUser() user: any,
  ) {
    return this.nextSessionPlansService.create(tenantId, user.userId, createDto);
  }

  @Roles('MASTER', 'PROFESIONAL')
  @Get()
  @ApiOperation({ summary: 'List all session plans' })
  @ApiQuery({ name: 'psychologistId', required: false })
  @ApiResponse({ status: 200, description: 'Plans list' })
  @RequirePermission('clinical_records.view')
  async findAll(
    @Param('tenantId') tenantId: string,
    @Query('psychologistId') psychologistId?: string,
  ) {
    return this.nextSessionPlansService.findAll(tenantId, psychologistId);
  }

  @Roles('MASTER', 'PROFESIONAL')
  @Get('patient/:patientId')
  @ApiOperation({ summary: 'Get session plan for specific patient' })
  @ApiResponse({ status: 200, description: 'Plan found' })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  @RequirePermission('clinical_records.view')
  async findByPatient(@Param('tenantId') tenantId: string, @Param('patientId') patientId: string) {
    return this.nextSessionPlansService.findByPatient(tenantId, patientId);
  }

  @Roles('PROFESIONAL')
  @Patch('patient/:patientId')
  @ApiOperation({ summary: 'Update session plan for patient' })
  @ApiResponse({ status: 200, description: 'Plan updated' })
  @RequirePermission('clinical_records.update')
  @UseGuards(HealthSpecialtyGuard)
  async update(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Body() updateDto: UpdateNextSessionPlanDto,
    @CurrentUser() user: any,
  ) {
    return this.nextSessionPlansService.update(tenantId, patientId, user.userId, updateDto);
  }

  @Roles('MASTER', 'PROFESIONAL')
  @Delete('patient/:patientId')
  @ApiOperation({ summary: 'Delete session plan' })
  @ApiResponse({ status: 200, description: 'Plan deleted' })
  @RequirePermission('clinical_records.update')
  @UseGuards(HealthSpecialtyGuard)
  async remove(@Param('tenantId') tenantId: string, @Param('patientId') patientId: string) {
    return this.nextSessionPlansService.delete(tenantId, patientId);
  }
}
