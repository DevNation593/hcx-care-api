import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BillingProfileKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateBillingProfileDto {
  @ApiProperty({ enum: BillingProfileKind })
  @IsEnum(BillingProfileKind)
  kind: BillingProfileKind;

  @ApiProperty({
    enum: ['04', '05', '06', '07'],
    description: 'SRI code: RUC, cedula, passport, final consumer.',
  })
  @IsIn(['04', '05', '06', '07'])
  idType: '04' | '05' | '06' | '07';

  @ApiProperty({ example: '1710034065' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  idNumber: string;

  @ApiProperty({ example: 'María Pérez' })
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  legalName: string;

  @ApiPropertyOptional({ description: 'Required unless idType is 07.' })
  @ValidateIf((dto: CreateBillingProfileDto) => dto.idType !== '07' || dto.email !== undefined)
  @Transform(trimText)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(30)
  phone?: string;
}

/** idType and idNumber never change once the profile exists. */
export class UpdateBillingProfileDto {
  @ApiPropertyOptional()
  // Not IsOptional: null must fail validation, the name is required.
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  legalName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimText)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class LinkBillingProfileDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  billingProfileId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class ListBillingProfilesQuery {
  @ApiPropertyOptional({ description: 'Name contains, or identification prefix.' })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: 'true' | 'false';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
