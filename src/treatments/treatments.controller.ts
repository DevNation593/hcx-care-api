import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { CreateTreatmentDto, TreatmentVersionDto, UpdateTreatmentDto } from './dto/treatment.dto';
import { TreatmentsService } from './treatments.service';

@ApiTags('treatments')
@ApiBearerAuth('access-token')
@RequireSection('core.treatments.catalog')
@Controller('tenants/:tenantId/treatments')
export class TreatmentsController {
  constructor(private readonly treatmentsService: TreatmentsService) {}

  @Get()
  @Roles('MASTER', 'PROFESIONAL', 'ASISTENTE')
  @ApiOperation({ summary: 'Treatments of the clinic with their current version' })
  @ApiQuery({ name: 'active', required: false, type: Boolean })
  list(@Param('tenantId') tenantId: string, @Query('active') active?: string) {
    return this.treatmentsService.list(tenantId, {
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Post()
  @Roles('MASTER')
  @RequirePermission('treatments.manage')
  @ApiOperation({
    summary: 'Create a treatment',
    description:
      'Starts with version 1. 400 TREATMENT_REQUIREMENTS_INVALID (with issues), 409 TREATMENT_NAME_TAKEN.',
  })
  create(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTreatmentDto,
  ) {
    return this.treatmentsService.create(tenantId, user.userId, dto);
  }

  @Get(':id')
  @Roles('MASTER', 'PROFESIONAL', 'ASISTENTE')
  @ApiOperation({ summary: 'A treatment with every version' })
  get(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.treatmentsService.get(tenantId, id);
  }

  @Patch(':id')
  @Roles('MASTER')
  @RequirePermission('treatments.manage')
  @ApiOperation({
    summary: 'Change name, category, specialty or active state',
    description: 'Price and requirements change through a new version.',
  })
  update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTreatmentDto,
  ) {
    return this.treatmentsService.update(tenantId, id, dto);
  }

  @Post(':id/versions')
  @Roles('MASTER')
  @RequirePermission('treatments.manage')
  @ApiOperation({
    summary: 'Add a version, which becomes the current one',
    description:
      'Earlier versions stay as they were. 400 TREATMENT_REQUIREMENTS_INVALID (with issues), 409 TREATMENT_VERSION_CONFLICT.',
  })
  addVersion(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: TreatmentVersionDto,
  ) {
    return this.treatmentsService.addVersion(tenantId, user.userId, id, dto);
  }
}
