import { Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PatientTeamService } from './patient-team.service';
import { RequireSection } from '../common/decorators/require-section.decorator';

@ApiTags('patient-team')
@ApiBearerAuth('access-token')
@RequireSection('core.patients.team')
@Roles('MASTER', 'ASISTENTE', 'PROFESIONAL')
@Controller('tenants/:tenantId/patients/:patientId/team')
export class PatientTeamController {
  constructor(private readonly service: PatientTeamService) {}

  @Get()
  list(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.list(tenantId, patientId, actor);
  }

  @Get('eligible')
  listEligible(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Query('specialtyId') specialtyId: string | undefined,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.listEligible(tenantId, patientId, specialtyId, actor);
  }

  @Put(':professionalId')
  assign(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('professionalId') professionalId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.assign(tenantId, patientId, professionalId, actor);
  }

  @Delete(':professionalId')
  remove(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('professionalId') professionalId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.service.remove(tenantId, patientId, professionalId, actor);
  }
}
