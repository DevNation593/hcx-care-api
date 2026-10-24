import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { PLAN_VALUE_FIELD_NAMES } from '../../plans/plan-values';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ChangePlanDto {
  @ApiProperty({ description: 'A plan of the clinic type that is not archived.' })
  @IsString()
  @IsNotEmpty()
  planId: string;

  @ApiPropertyOptional({
    description:
      'Days of trial on the new plan. Without it, the clinic starts paying the plan (or keeps its running period).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  trialDays?: number;

  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  reason: string;
}

/**
 * Price and limit values set for one clinic apart from its plan. `values` overrides fields;
 * `reset` puts fields back on the plan's value.
 */
export class SetPlanOverridesDto {
  @ApiProperty({
    description: `Field to value. Fields: ${PLAN_VALUE_FIELD_NAMES.join(', ')}.`,
    example: { maxActivePatients: 300, basePrice: 79 },
  })
  @IsDefined()
  @IsObject()
  values: Record<string, number | string>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsIn(PLAN_VALUE_FIELD_NAMES, { each: true })
  reset?: string[];

  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  reason: string;
}
