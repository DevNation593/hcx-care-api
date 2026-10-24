import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ClinicalModulesService } from './clinical-modules.service';
import { CreateFormDefinitionDto, UpdateFormDefinitionDto } from './dto/form-definition.dto';
import { FormDefinitionsService } from './form-definitions.service';

@ApiTags('clinical-modules')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.specialties')
@Controller('tenants/:tenantId')
export class ClinicalModulesController {
  constructor(
    private readonly modulesService: ClinicalModulesService,
    private readonly formsService: FormDefinitionsService,
  ) {}

  @Get('clinical-modules')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Definitions of the clinical modules and tenant forms',
    description:
      'Every version, so stored records can be rendered with the definition they were written under. `canRecord` marks the versions the caller may create records of.',
  })
  listModules(@Param('tenantId') tenantId: string, @CurrentUser() user: AuthUser) {
    return this.modulesService.listForTenant(tenantId, user.userId);
  }

  @Get('form-definitions')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({ summary: 'List the forms designed by the clinic, with all their versions' })
  listForms(@Param('tenantId') tenantId: string) {
    return this.formsService.list(tenantId);
  }

  @Get('form-definitions/:formId')
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({ summary: 'Get one form with all its versions' })
  findForm(@Param('tenantId') tenantId: string, @Param('formId') formId: string) {
    return this.formsService.findOne(tenantId, formId);
  }

  @Post('form-definitions')
  @RequireSection('core.clinical.forms')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Create a form (version 1)' })
  createForm(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFormDefinitionDto,
  ) {
    return this.formsService.create(tenantId, user.userId, dto);
  }

  @Patch('form-definitions/:formId')
  @RequireSection('core.clinical.forms')
  @Roles('MASTER')
  @ApiOperation({
    summary: 'Update a form',
    description:
      'A changed schema is stored as a new version; earlier versions and the records written under them are never modified.',
  })
  updateForm(
    @Param('tenantId') tenantId: string,
    @Param('formId') formId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateFormDefinitionDto,
  ) {
    return this.formsService.update(tenantId, formId, user.userId, dto);
  }
}
