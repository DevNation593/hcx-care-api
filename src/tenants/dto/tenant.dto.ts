import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, IsEmail, IsOptional, IsBoolean, IsNotEmpty, MaxLength } from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class UpdateTenantDto {
  @ApiPropertyOptional({ example: 'Consultorio Bienestar' })
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'contacto@bienestar.ec' })
  @Transform(trimEmail)
  @IsEmail()
  @MaxLength(254)
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ description: 'An empty string clears it.' })
  @Transform(trimText)
  @IsString()
  @MaxLength(40)
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: 'An empty string clears it.' })
  @Transform(trimText)
  @IsString()
  @MaxLength(300)
  @IsOptional()
  address?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  legalName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  taxIdentificationType?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  taxIdentificationNumber?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  logoUrl?: string;
}

export class CompleteOnboardingDto {
  @ApiProperty()
  @IsBoolean()
  completed: boolean;
}
