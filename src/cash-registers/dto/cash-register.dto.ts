import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CashRegisterStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Non-negative decimal with at most 2 decimals.
const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const MONEY_MESSAGE = 'El monto debe ser un decimal mayor o igual a 0 con hasta 2 decimales.';

export class OpenCashRegisterDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  branchId: string;

  @ApiProperty({ example: '50.00' })
  @Matches(MONEY, { message: MONEY_MESSAGE })
  openingCash: string;
}

export class CloseCashRegisterDto {
  @ApiProperty({ example: '180.00' })
  @Matches(MONEY, { message: MONEY_MESSAGE })
  countedCash: string;

  @ApiPropertyOptional({ description: 'Required when the count differs from the expected cash.' })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  closingNote?: string;
}

export class ListCashRegistersQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchId?: string;

  @ApiPropertyOptional({ enum: CashRegisterStatus })
  @IsOptional()
  @IsEnum(CashRegisterStatus)
  status?: CashRegisterStatus;

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
