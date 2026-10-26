import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Decimal with at most 2 decimals, zero allowed.
const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const CALENDAR_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class StockReceiptLineDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  productId: string;

  @ApiProperty({ example: 10, description: 'Whole units, at least 1.' })
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity: number;

  @ApiProperty({ example: '2.50', description: 'Unit cost without tax; 0 or more.' })
  @Matches(MONEY, { message: 'unitCost debe ser un decimal con hasta 2 decimales.' })
  unitCost: string;

  @ApiPropertyOptional({ example: 'L-2026-10' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  lotNumber?: string;

  @ApiPropertyOptional({
    example: '2027-06-30',
    description: 'YYYY-MM-DD; required when the product tracks expiry.',
  })
  @IsOptional()
  @Matches(CALENDAR_DATE, { message: 'expiresAt debe tener el formato AAAA-MM-DD.' })
  @IsISO8601({ strict: true }, { message: 'expiresAt no es una fecha válida.' })
  expiresAt?: string;
}

export class CreateStockReceiptDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  branchId: string;

  @ApiPropertyOptional()
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplierName?: string;

  @ApiPropertyOptional()
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(60)
  documentNumber?: string;

  @ApiPropertyOptional({ description: 'ISO date-time; defaults to now.' })
  @IsOptional()
  @IsISO8601()
  receivedAt?: string;

  @ApiPropertyOptional()
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiProperty({ type: [StockReceiptLineDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StockReceiptLineDto)
  lines: StockReceiptLineDto[];
}

export class ListStockReceiptsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchId?: string;

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
