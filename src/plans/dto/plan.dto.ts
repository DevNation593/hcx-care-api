import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { TenantType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const upperCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const money = { maxDecimalPlaces: 2 };

export class CreatePlanDto {
  @ApiProperty({ example: 'CLINIC_PRO', description: 'A-Z, 0-9 and _, stored uppercase.' })
  @Transform(upperCode)
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9_]{1,39}$/, {
    message: 'El código usa de 2 a 40 letras, números o _',
  })
  code: string;

  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ enum: TenantType })
  @IsEnum(TenantType)
  tenantType: TenantType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiProperty({ description: 'USD per month; 0 means agreed with sales.' })
  @IsNumber(money)
  @Min(0)
  basePrice: number;

  @ApiProperty()
  @IsNumber(money)
  @Min(0)
  pricePerSeat: number;

  @ApiProperty({ description: 'Price of each specialty beyond the included ones.' })
  @IsNumber(money)
  @Min(0)
  specialtyPrice: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  seatsIncluded: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  maxActivePatients: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  storageGB: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  monthlyElectronicInvoicesLimit: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  includedSpecialties: number;

  @ApiProperty({ description: 'Trial days suggested when the plan is given to a clinic.' })
  @IsInt()
  @Min(0)
  trialDays: number;

  @ApiProperty({ type: [String], description: 'Module and submodule keys (core.*) it includes.' })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  modules: string[];
}

/** Every field but the code, which identifies the plan for good. */
export class UpdatePlanDto extends PartialType(OmitType(CreatePlanDto, ['code'] as const)) {}
