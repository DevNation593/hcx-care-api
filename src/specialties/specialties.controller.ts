import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SpecialtiesService } from './specialties.service';

@ApiTags('specialties')
@ApiBearerAuth('access-token')
@Controller('tenants/:tenantId')
export class SpecialtiesController {
  constructor(private readonly specialtiesService: SpecialtiesService) {}

  @Get('specialties')
  @ApiOperation({ summary: 'List the specialties enabled for a practice' })
  listSpecialties(@Param('tenantId') tenantId: string) {
    return this.specialtiesService.listForTenant(tenantId);
  }

  @Get('modules')
  @ApiOperation({ summary: 'List the modules enabled for a practice' })
  listModules(@Param('tenantId') tenantId: string) {
    return this.specialtiesService.listModulesForTenant(tenantId);
  }
}
