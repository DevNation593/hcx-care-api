import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StockAdjustmentReason } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Exactly one of `delta` or `countedQuantity` (the service rejects both). */
export class CreateStockAdjustmentDto {
  @ApiPropertyOptional({ example: -2, description: 'Signed whole units to add to the balance.' })
  @ValidateIf((dto: CreateStockAdjustmentDto) => dto.countedQuantity === undefined)
  @IsInt()
  @Min(-1000000)
  @Max(1000000)
  delta?: number;

  @ApiPropertyOptional({
    example: 7,
    description: 'Physical count; the delta is counted − balance.',
  })
  @ValidateIf((dto: CreateStockAdjustmentDto) => dto.delta === undefined)
  @IsInt()
  @Min(0)
  @Max(1000000)
  countedQuantity?: number;

  @ApiProperty({ enum: StockAdjustmentReason })
  @IsEnum(StockAdjustmentReason)
  reason: StockAdjustmentReason;

  @ApiPropertyOptional({ description: 'Required with reason OTHER.' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
