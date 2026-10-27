import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

export const EXPIRING_DAYS = [30, 60, 90] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class BranchReportQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchId?: string;
}

export class ExpiringReportQuery extends BranchReportQuery {
  @ApiPropertyOptional({ enum: EXPIRING_DAYS, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsIn(EXPIRING_DAYS)
  days?: number;
}

export class MarginReportQuery extends BranchReportQuery {
  @ApiProperty({ example: '2026-10-01', description: 'First clinic day, inclusive.' })
  @Matches(DATE_PATTERN, { message: 'from debe tener el formato AAAA-MM-DD' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Last clinic day, inclusive.' })
  @Matches(DATE_PATTERN, { message: 'to debe tener el formato AAAA-MM-DD' })
  to!: string;
}
