import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const trimCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export class CreatePlatformTenantDto {
  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty()
  @Transform(trimEmail)
  @IsEmail()
  email: string;

  @ApiPropertyOptional()
  @Transform(trimText)
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @Transform(trimText)
  @IsOptional()
  @IsString()
  address?: string;

  @ApiProperty({ enum: TenantType })
  @IsEnum(TenantType)
  tenantType: TenantType;

  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  timezone: string;

  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  locale: string;

  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  masterFirstName: string;

  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  masterLastName: string;

  @ApiProperty()
  @Transform(trimEmail)
  @IsEmail()
  masterEmail: string;

  /** Never trimmed or normalized: the master receives it exactly as typed. */
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  temporaryPassword: string;

  @ApiProperty({ description: 'A plan of the same tenant type that is not archived.' })
  @IsString()
  @IsNotEmpty()
  planId: string;

  @ApiPropertyOptional({
    description: 'Days of trial on the plan; the plan suggests its own. 0 starts a paid month.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  trialDays?: number;

  @ApiProperty({ type: [String] })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((code) => trimCode({ value: code })) : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  specialtyCodes: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Modules to turn on; what differs from the plan becomes an override.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sections?: string[];
}
