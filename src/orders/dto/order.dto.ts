import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderItemKind, OrderStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
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
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Non-negative decimal with at most 2 decimals.
const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const MONEY_MESSAGE = 'El monto debe ser un decimal mayor o igual a 0 con hasta 2 decimales.';
// Non-negative decimal with at most 6 decimals (positivity is checked by the totals).
const QUANTITY = /^\d{1,6}(\.\d{1,6})?$/;

/**
 * QUANTITY for every kind but PRODUCT, whose whole-number rule the service answers with
 * 422 ORDER_LINE_INVALID. Unlike ValidateIf, it leaves the property's other validators on.
 */
const QuantityUnlessProduct = () =>
  ValidateBy({
    name: 'quantityUnlessProduct',
    validator: {
      validate: (value: unknown, args) =>
        (args?.object as { kind?: unknown }).kind === 'PRODUCT' ||
        (typeof value === 'string' && QUANTITY.test(value)),
      defaultMessage: () => 'La cantidad debe ser un decimal con hasta 6 decimales.',
    },
  });

export class CreateOrderDto {
  @ApiPropertyOptional({ description: 'Required when no session fixes the branch.' })
  @IsOptional()
  @IsString()
  branchId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  treatmentSessionIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  billingProfileId?: string;
}

export class AddOrderItemDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  version: number;

  @ApiProperty({ enum: OrderItemKind })
  @IsEnum(OrderItemKind)
  kind: OrderItemKind;

  @ApiPropertyOptional({ description: 'Required for TREATMENT_SESSION.' })
  @IsOptional()
  @IsString()
  treatmentSessionId?: string;

  @ApiPropertyOptional({ description: 'Required for PRODUCT.' })
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional({ description: 'Required for FREE.' })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({
    example: '1',
    description: 'FREE: defaults to 1. PRODUCT: required, a whole number of at least 1.',
  })
  @IsOptional()
  @IsString()
  @QuantityUnlessProduct()
  quantity?: string;

  @ApiPropertyOptional({ example: '25.00', description: 'Required for FREE.' })
  @IsOptional()
  @Matches(/^\d{1,8}(\.\d{1,2})?$/, { message: MONEY_MESSAGE })
  unitPrice?: string;

  @ApiPropertyOptional({ example: 15, description: 'Required for FREE: 0, 5 or 15.' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxRatePercent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  patientId?: string;

  @ApiPropertyOptional({ example: '0.00', description: 'Requires billing.adjust when not zero.' })
  @IsOptional()
  @Matches(MONEY, { message: MONEY_MESSAGE })
  discount?: string;
}

export class UpdateOrderItemDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  version: number;

  @ApiProperty({ example: '5.00' })
  @Matches(MONEY, { message: MONEY_MESSAGE })
  discount: string;
}

export class SetOrderBillingProfileDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  version: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  billingProfileId: string;
}

export class CancelOrderDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  version: number;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}

export class ListOrdersQuery {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Order number, billing profile or patient name.' })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(100)
  q?: string;

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

/** Used by the billable-sessions route. */
export class BillableSessionsQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  patientId?: string;
}
