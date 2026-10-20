import { AestheticBookingStatus } from '@prisma/client';
import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAestheticClientDto {
  @IsString() @IsNotEmpty() @MaxLength(100) firstName: string;
  @IsString() @IsNotEmpty() @MaxLength(100) lastName: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
}

export class UpdateAestheticClientDto extends PartialType(CreateAestheticClientDto) {}

export class CreateAestheticServiceDto {
  @IsString() @IsNotEmpty() @MaxLength(140) name: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @Type(() => Number) @IsInt() @Min(5) @Max(480) durationMinutes: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price: number;
  @IsOptional() @IsString() @MaxLength(10000) consentText?: string;
}

export class UpdateAestheticServiceDto extends PartialType(CreateAestheticServiceDto) {}

export class CreateAestheticBookingDto {
  @IsString() @IsNotEmpty() clientId: string;
  @IsString() @IsNotEmpty() serviceId: string;
  @IsString() @IsNotEmpty() staffId: string;
  @IsISO8601() startAt: string;
}

export class ListAestheticBookingsDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class UpdateAestheticBookingDto {
  @IsOptional() @IsISO8601() startAt?: string;
  @IsOptional() @IsString() staffId?: string;
  @IsOptional() @IsEnum(AestheticBookingStatus) status?: AestheticBookingStatus;
}

export class CreateAestheticSessionDto {
  @IsString() @IsNotEmpty() clientId: string;
  @IsString() @IsNotEmpty() serviceId: string;
  @IsString() @IsNotEmpty() staffId: string;
  @IsOptional() @IsString() bookingId?: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
}

export class CompleteAestheticSessionDto {
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
}

export class RecordAestheticConsentDto {
  @IsString() @IsNotEmpty() @MaxLength(200) signerName: string;
  @IsString() @IsNotEmpty() @MaxLength(10000) expectedConsentText: string;
}
