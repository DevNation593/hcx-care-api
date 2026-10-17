import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_SIGNATURE_CHARS } from '../../clinical-forms/form-schema';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// A declaration is only a real boolean: implicit conversion would read the text "false" as true.
const rawValue = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => obj[key];

export const CONSENT_SIGNER_ROLES = ['PATIENT', 'REPRESENTATIVE'] as const;

export class SignConsentDto {
  @ApiProperty({ enum: CONSENT_SIGNER_ROLES, example: 'PATIENT' })
  @IsIn(CONSENT_SIGNER_ROLES)
  signerRole: 'PATIENT' | 'REPRESENTATIVE';

  @ApiProperty({ example: 'Ana Pérez' })
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  signerName: string;

  @ApiPropertyOptional({ example: '0102030405' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  signerIdentification?: string;

  @ApiPropertyOptional({
    example: 'Madre',
    description: 'Relationship of the representative to the patient. Required for REPRESENTATIVE.',
  })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  relationship?: string;

  @ApiProperty({ example: true, description: 'The signer understood the text. Must be true.' })
  @Transform(rawValue)
  @IsBoolean()
  understood: boolean;

  @ApiProperty({ example: true, description: 'The signer questions were answered. Must be true.' })
  @Transform(rawValue)
  @IsBoolean()
  questionsAnswered: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Separate authorization to use the photos in advertising. Defaults to false.',
  })
  @Transform(rawValue)
  @IsOptional()
  @IsBoolean()
  marketingPhotos?: boolean;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgo...',
    description: 'The signature drawn on screen, as a PNG data URL (checked by its bytes).',
  })
  @IsString()
  @MaxLength(MAX_SIGNATURE_CHARS)
  signature: string;
}

export class ConsentReasonDto {
  @ApiProperty({ example: 'El paciente prefiere pensarlo.' })
  @Transform(trimText)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}
