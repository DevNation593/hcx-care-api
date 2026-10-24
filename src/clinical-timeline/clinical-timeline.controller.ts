import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ClinicalTimelineService } from './clinical-timeline.service';
import { ClinicalTimelineQueryDto } from './dto/clinical-timeline-query.dto';
import { RequirePermission } from '../common/permissions/permission-catalog';

@ApiTags('clinical-timeline')
@ApiBearerAuth('access-token')
@RequireSection('core.clinical.timeline')
@Roles('MASTER', 'PROFESIONAL')
@UseGuards(ClinicalProfileGuard)
@Controller('tenants/:tenantId/patients/:patientId/clinical-timeline')
export class ClinicalTimelineController {
  constructor(private readonly timelineService: ClinicalTimelineService) {}

  @Get()
  @ApiOperation({
    summary: 'Shared clinical timeline of a patient',
    description:
      'Appointments, clinical notes and specialty records in chronological order. Requires an active professional profile; every clinical record returned is audited.',
  })
  @RequirePermission('clinical_records.view')
  getTimeline(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Query() query: ClinicalTimelineQueryDto,
  ) {
    return this.timelineService.getTimeline(tenantId, patientId, actor, query);
  }
}
