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
import { RimpeRegime, SriEnvironment } from '../sri/sri-types';

const RIMPE_REGIMES: RimpeRegime[] = ['NONE', 'EMPRENDEDOR', 'NEGOCIO_POPULAR'];
const NOT_BLANK = /\S/;
const SERIES_CODE = /^(?!000)\d{3}$/;

export class SaveIssuerDto {
  @IsString() @Matches(/^\d{10}001$/) ruc!: string;
  @IsString() @MinLength(1) @MaxLength(300) @Matches(NOT_BLANK) legalName!: string;
  @IsOptional() @IsString() @MaxLength(300) tradeName?: string | null;
  @IsString() @MinLength(1) @MaxLength(300) @Matches(NOT_BLANK) headOfficeAddress!: string;
  @IsBoolean() accountingRequired!: boolean;
  @IsOptional() @IsString() @Matches(/^\d{3,13}$/) specialTaxpayerCode?: string | null;
  @IsOptional() @IsString() @Matches(/^\d{1,8}$/) withholdingAgentCode?: string | null;
  @IsIn(RIMPE_REGIMES) rimpeRegime!: RimpeRegime;
  @IsIn(['1', '2']) environment!: SriEnvironment;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(1) revision?: number;
}

export class IssuerCertificateDto {
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
}

export class IssuerEmissionPointDto {
  @IsString() @Matches(SERIES_CODE) establishmentCode!: string;
  @IsString() @Matches(SERIES_CODE) emissionPointCode!: string;
  @IsString() @MinLength(1) @MaxLength(300) @Matches(NOT_BLANK) establishmentAddress!: string;
  @IsOptional() @IsInt() @Min(1) @Max(999999999) nextSequential?: number;
}
