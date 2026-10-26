import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SUPPORTED_FREE_TAX_RATES } from '../../orders/order-totals';
import { TREATMENT_CODE_PATTERN } from '../../treatments/dto/treatment.dto';
import { normalizeCatalogCode } from '../catalog-codes';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const upperCode = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? normalizeCatalogCode(value) : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

// Decimal with at most 2 decimals; positivity is checked on its own.
const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const POSITIVE_MONEY = /^(?!0+(\.0{1,2})?$)\d{1,8}(\.\d{1,2})?$/;

const codeMessage =
  'code debe tener de 1 a 20 caracteres: letras, números, punto, guion o guion bajo, empezando por letra o número.';

export class CreateProductDto {
  @ApiProperty({
    example: 'PROT-01',
    description: 'Invoice code; stored in uppercase, unique across products and treatments.',
  })
  @Transform(upperCode)
  @IsString()
  @Matches(TREATMENT_CODE_PATTERN, { message: codeMessage })
  code: string;

  @ApiProperty({ example: 'Protector solar SPF 50' })
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: 'Cuidado de la piel' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional({ example: '7501234567890' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @ApiProperty({ example: '25.00', description: 'Sale price without tax; greater than 0.' })
  @Matches(MONEY, { message: 'price debe ser un decimal con hasta 2 decimales.' })
  @Matches(POSITIVE_MONEY, { message: 'price debe ser mayor que 0.' })
  price: string;

  @ApiProperty({ example: 15, enum: SUPPORTED_FREE_TAX_RATES as number[] })
  @IsNumber()
  @IsIn(SUPPORTED_FREE_TAX_RATES as number[], {
    message: `taxRatePercent debe ser una de: ${SUPPORTED_FREE_TAX_RATES.join(', ')}.`,
  })
  taxRatePercent: number;

  @ApiProperty({ description: 'Whether each lot carries an expiry date.' })
  @IsBoolean()
  tracksExpiry: boolean;

  @ApiPropertyOptional({ example: 5, description: '0 means no low-stock alert.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000000)
  minStock?: number;
}

export class UpdateProductDto extends PartialType(CreateProductDto) {}

export class SetProductActiveDto {
  @ApiProperty()
  @IsBoolean()
  isActive: boolean;
}

export class ListProductsQuery {
  @ApiPropertyOptional({ description: 'Name, code or barcode.' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional()
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  active?: boolean;

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

export class ProductsForSaleQuery {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  branchId: string;

  @ApiPropertyOptional({ description: 'Name or code, case-insensitive.' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Exact barcode.' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;
}

export class ProductLotsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchId?: string;
}
