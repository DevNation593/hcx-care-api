import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { ReportsService } from './reports.service';

export class ActivityReportQueryDto {
  @ApiProperty({
    example: '2026-10-01T05:00:00.000Z',
    description: 'Start of the period, inclusive.',
  })
  @IsISO8601()
  from: string;

  @ApiProperty({
    example: '2026-11-01T05:00:00.000Z',
    description: 'End of the period, exclusive.',
  })
  @IsISO8601()
  to: string;

  @ApiPropertyOptional({ example: 'branch_cuid', description: 'Only this branch.' })
  @IsString()
  @IsOptional()
  branchId?: string;
}

@ApiTags('reports')
@ApiBearerAuth('access-token')
@RequireSection('core.admin.reports')
@Controller('tenants/:tenantId/reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('activity')
  @Roles('MASTER')
  @ApiOperation({
    summary: 'Appointments and encounters by branch and by professional',
    description:
      'Counts for a period of up to a year. It holds no clinical content: only how many appointments and encounters there were, by status and type.',
  })
  activity(@Param('tenantId') tenantId: string, @Query() query: ActivityReportQueryDto) {
    return this.reportsService.activity(tenantId, query);
  }
}
