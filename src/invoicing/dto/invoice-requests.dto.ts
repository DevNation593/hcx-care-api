import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
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
