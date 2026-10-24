import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { DocumentTemplatesService } from './document-templates.service';
import { CreateDocumentTemplateDto, UpdateDocumentTemplateDto } from './dto/document-template.dto';

@ApiTags('document-templates')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.specialties')
@Controller('tenants/:tenantId/document-templates')
export class DocumentTemplatesController {
  constructor(private readonly templatesService: DocumentTemplatesService) {}

  @Get()
  @Roles('MASTER', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Templates of the clinic for certificates and consents',
    description: 'The account holder also sees the inactive ones.',
  })
  @ApiQuery({ name: 'moduleKey', required: false })
  list(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query('moduleKey') moduleKey?: string,
  ) {
    return this.templatesService.list(tenantId, {
      moduleKey,
      activeOnly: user.role !== 'MASTER',
    });
  }

  @Post()
  @RequireSection('core.clinical.templates')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Add a template' })
  create(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateDocumentTemplateDto,
  ) {
    return this.templatesService.create(tenantId, user.userId, dto);
  }

  @Patch(':templateId')
  @RequireSection('core.clinical.templates')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Update a template or take it out of use' })
  update(
    @Param('tenantId') tenantId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateDocumentTemplateDto,
  ) {
    return this.templatesService.update(tenantId, templateId, dto);
  }
}
