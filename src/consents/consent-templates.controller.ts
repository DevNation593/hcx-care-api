import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { ConsentTemplatesService } from './consent-templates.service';
import { CreateConsentTemplateDto, SaveConsentDraftDto } from './dto/consent-template.dto';

@ApiTags('consent-templates')
@ApiBearerAuth('access-token')
@RequireSection('core.specialties')
@Controller('tenants/:tenantId')
export class ConsentTemplatesController {
  constructor(private readonly templatesService: ConsentTemplatesService) {}

  @Get('consent-templates')
  @Roles('MASTER', 'PROFESIONAL', 'ASISTENTE')
  @ApiOperation({
    summary: 'Consent templates with the state of each version',
    description: 'The text of the versions is left out; read one template to get it.',
  })
  list(@Param('tenantId') tenantId: string) {
    return this.templatesService.list(tenantId);
  }

  @Post('consent-templates')
  @Roles('MASTER')
  @RequirePermission('treatments.manage')
  @ApiOperation({
    summary: 'Create a consent template',
    description: 'Starts with version 1 as a draft. 409 CONSENT_TEMPLATE_NAME_TAKEN.',
  })
  create(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateConsentTemplateDto,
  ) {
    return this.templatesService.create(tenantId, user.userId, dto);
  }

  @Get('consent-templates/:id')
  @Roles('MASTER', 'PROFESIONAL', 'ASISTENTE')
  @ApiOperation({ summary: 'A consent template with the text of every version' })
  get(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.templatesService.get(tenantId, id);
  }

  @Put('consent-templates/:id/draft')
  @Roles('MASTER')
  @RequirePermission('treatments.manage')
  @ApiOperation({
    summary: 'Replace the draft, or start the next version as a draft',
    description: 'Published and retired versions are never edited.',
  })
  saveDraft(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SaveConsentDraftDto,
  ) {
    return this.templatesService.saveDraft(tenantId, user.userId, id, dto);
  }

  @Post('consent-templates/:id/publish')
  @HttpCode(200)
  @Roles('MASTER')
  @RequirePermission('treatments.manage')
  @ApiOperation({
    summary: 'Publish the draft',
    description: 'Fixes its text and fingerprint. 409 CONSENT_VERSION_LOCKED without a draft.',
  })
  publish(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.templatesService.publish(tenantId, user.userId, id);
  }

  @Post('consent-template-versions/:versionId/retire')
  @HttpCode(200)
  @Roles('MASTER')
  @RequirePermission('treatments.manage')
  @ApiOperation({
    summary: 'Retire a published version',
    description:
      'Treatments and documents that already use it keep it. 409 CONSENT_VERSION_LOCKED.',
  })
  retire(@Param('tenantId') tenantId: string, @Param('versionId') versionId: string) {
    return this.templatesService.retire(tenantId, versionId);
  }
}
