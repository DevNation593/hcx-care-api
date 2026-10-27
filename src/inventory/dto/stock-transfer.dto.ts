import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StockMovementKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class StockTransferLineDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  lotId: string;

  @ApiProperty({ example: 2, description: 'Whole units, at least 1.' })
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity: number;
}

export class CreateStockTransferDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  fromBranchId: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  toBranchId: string;

  @ApiPropertyOptional()
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiProperty({ type: [StockTransferLineDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StockTransferLineDto)
  lines: StockTransferLineDto[];
}

class PageQuery {
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

export class ListStockTransfersQuery extends PageQuery {
  @ApiPropertyOptional({ description: 'Transfers leaving or arriving at this branch.' })
  @IsOptional()
  @IsString()
  branchId?: string;
}

export class ListStockMovementsQuery extends PageQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchId?: string;

  @ApiPropertyOptional({ enum: StockMovementKind })
  @IsOptional()
  @IsEnum(StockMovementKind)
  kind?: StockMovementKind;

  @ApiPropertyOptional({ description: 'ISO date-time, inclusive.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date-time, inclusive.' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
