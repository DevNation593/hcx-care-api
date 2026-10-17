import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
export class TestConnectionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(512) apiKey?: string;
}
export class SaveConnectionDto extends TestConnectionDto {
  @IsString() @MinLength(1) @MaxLength(100) taxpayerId!: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @Matches(/^$|^whsec_[A-Za-z0-9+/]{43}=$/) webhookSecret?: string;
}
export class EmissionPointDto {
  @IsString() @MinLength(1) @MaxLength(100) establishmentId!: string;
  @IsString() @MinLength(1) @MaxLength(100) emissionPointId!: string;
}
export class ListInvoiceRequestsQuery {
  @IsOptional() @IsIn(['REQUESTED', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'FAILED']) status?:
    | 'REQUESTED'
    | 'PROCESSING'
    | 'AUTHORIZED'
    | 'REJECTED'
    | 'FAILED';
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() orderId?: string;
  @IsOptional() @IsString() patientId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize: number = 20;
}
