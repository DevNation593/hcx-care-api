import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PlanType, TenantType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
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

  @ApiProperty({ enum: PlanType })
  @IsEnum(PlanType)
  planType: PlanType;

  @ApiProperty({ type: [String] })
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((code) => trimCode({ value: code })) : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  specialtyCodes: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sections?: string[];
}
