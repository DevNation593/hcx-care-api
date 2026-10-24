import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SubscriptionStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MinLength,
  Min,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
// Reads the raw query value: with implicit conversion enabled, `value` is already
// Boolean('false') === true by the time this runs.
const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }) =>
  obj[key] === 'true' ? true : obj[key] === 'false' ? false : obj[key];

export class ListPlatformTenantsQueryDto {
  @ApiPropertyOptional()
  @Transform(trimText)
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  planId?: string;

  @ApiPropertyOptional({ enum: SubscriptionStatus })
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @ApiPropertyOptional()
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class UpdatePlatformTenantDto {
  @ApiPropertyOptional()
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional()
  @Transform(trimEmail)
  @IsOptional()
  @IsEmail()
  email?: string;

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
}

export class SuspendPlatformTenantDto {
  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class SetPlatformTenantSectionsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  sections: string[];
}

export class ResetMasterPasswordDto {
  /** Never trimmed or normalized: the master receives it exactly as typed. */
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  temporaryPassword: string;
}
