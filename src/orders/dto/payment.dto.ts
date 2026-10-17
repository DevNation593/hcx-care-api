import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Decimal with at most 2 decimals; positivity is checked below.
const MONEY = /^\d{1,8}(\.\d{1,2})?$/;
const POSITIVE_MONEY = /^(?!0+(\.0{1,2})?$)\d{1,8}(\.\d{1,2})?$/;

export class RecordPaymentDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  @ApiProperty({ example: '10.00', description: 'Greater than 0, up to 2 decimals.' })
  @Matches(MONEY, { message: 'El monto debe ser un decimal con hasta 2 decimales.' })
  @Matches(POSITIVE_MONEY, { message: 'El monto debe ser mayor que 0.' })
  amount: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(100)
  reference?: string;
}

export class RefundPaymentDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
