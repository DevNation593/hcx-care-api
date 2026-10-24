import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CatalogsService } from './catalogs.service';
import { CreateMedicationDto, UpdateMedicationDto } from './dto/medication.dto';

@ApiTags('catalogs')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.specialties')
@Controller('tenants/:tenantId')
export class CatalogsController {
  constructor(private readonly catalogsService: CatalogsService) {}

  @Get('diagnosis-codes')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Search the diagnosis classification',
    description: 'Up to 20 matches by code prefix or description. At least 2 characters.',
  })
  @ApiQuery({ name: 'search', required: true })
  @ApiQuery({ name: 'system', required: false, enum: ['CIE10', 'CIE11'] })
  searchDiagnosisCodes(@Query('search') search = '', @Query('system') system?: string) {
    return this.catalogsService.searchDiagnosisCodes(String(search), system);
  }

  @Get('medications')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Medication catalog of the clinic',
    description: 'With `search`: up to 20 active matches. Without it: the whole catalog.',
  })
  @ApiQuery({ name: 'search', required: false })
  listMedications(@Param('tenantId') tenantId: string, @Query('search') search?: string) {
    return this.catalogsService.listMedications(tenantId, search);
  }

  @Post('medications')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({ summary: 'Add a medication to the catalog' })
  createMedication(@Param('tenantId') tenantId: string, @Body() dto: CreateMedicationDto) {
    return this.catalogsService.createMedication(tenantId, dto);
  }

  @Patch('medications/:medicationId')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({ summary: 'Update a medication or take it out of use' })
  updateMedication(
    @Param('tenantId') tenantId: string,
    @Param('medicationId') medicationId: string,
    @Body() dto: UpdateMedicationDto,
  ) {
    return this.catalogsService.updateMedication(tenantId, medicationId, dto);
  }
}
