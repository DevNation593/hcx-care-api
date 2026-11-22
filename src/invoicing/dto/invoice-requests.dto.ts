import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
const searchText = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  return value.trim() === '' ? undefined : value.trim();
};
export class ListInvoiceRequestsQuery {
  /** Invoice number: whole (001-001-000000123), partial (001-001) or the sequence alone (123). */
  @IsOptional()
  @Transform(searchText)
  @IsString()
  @Matches(/^[0-9-]{1,17}$/, {
    message: 'q debe contener solo dígitos y guiones (máximo 17 caracteres)',
  })
  q?: string;
  @IsOptional() @IsIn(['REQUESTED', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'FAILED']) status?:
    'REQUESTED' | 'PROCESSING' | 'AUTHORIZED' | 'REJECTED' | 'FAILED';
  @IsOptional() @IsString() branchId?: string;
  @IsOptional() @IsString() orderId?: string;
  @IsOptional() @IsString() patientId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize: number = 20;
}
