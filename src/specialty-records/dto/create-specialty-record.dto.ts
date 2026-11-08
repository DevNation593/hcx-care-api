import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateSpecialtyRecordDto {
  @ApiPropertyOptional({
    example: 'NUTRITION',
    description:
      'Kept for older clients. The specialty is taken from the module; a different code is rejected.',
  })
  @IsString()
  @IsOptional()
  specialtyCode?: string;

  @ApiProperty({
    example: 'nutrition.assessments',
    description: 'A module key, or `custom.<formDefinitionId>` for a form designed by the clinic.',
  })
  @IsString()
  moduleKey: string;

  @ApiPropertyOptional({
    example: 2,
    description:
      'Version of the definition the data follows, as returned by GET clinical-modules. Without it the legacy version of the module is used when one exists, otherwise the current one.',
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  schemaVersion?: number;

  @ApiProperty({ example: { weightKg: 72.5, heightCm: 168, waistCm: 84 } })
  @IsObject()
  data: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'Revisar evolución en 30 días.' })
  @IsString()
  @IsOptional()
  @MinLength(1)
  notes?: string;

  @ApiPropertyOptional({ example: '2026-09-22T10:00:00.000Z' })
  @IsISO8601()
  @IsOptional()
  recordDate?: string;

  @ApiPropertyOptional({ example: 'appointment_cuid' })
  @IsString()
  @IsOptional()
  appointmentId?: string;

  @ApiPropertyOptional({
    example: 'encounter_cuid',
    description: 'An open encounter of the caller with this patient; the record is written in it.',
  })
  @IsString()
  @IsOptional()
  encounterId?: string;

  @ApiPropertyOptional({
    example: 'record_cuid',
    description:
      'Makes this an addendum: a correction of that signed record of the caller, with the same module. It takes the encounter, appointment and date of the original, which stays as signed.',
  })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  amendsRecordId?: string;

  @ApiPropertyOptional({
    example: 'Días de reposo mal digitados.',
    description: 'Required with amendsRecordId: why the signed record is corrected.',
  })
  @IsString()
  @MaxLength(500)
  @IsOptional()
  amendmentReason?: string;

  @ApiPropertyOptional({
    description:
      'The password of the professional, required when the record is signed as it is saved: an addendum, or a record outside any encounter. A wrong or missing one answers 403 SIGNATURE_PASSWORD_INVALID.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  password?: string;
}

export class UpdateSpecialtyRecordDto {
  @ApiPropertyOptional({
    example: 2,
    description:
      'The version the caller edited. If someone saved since, the answer is 409 CLINICAL_RECORD_VERSION_CONFLICT instead of overwriting their change.',
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  version?: number;

  @ApiPropertyOptional({
    description:
      'Replaces the data. It is checked against the version the record was written under.',
  })
  @IsObject()
  @IsOptional()
  data?: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true, description: 'Null or an empty string clears the notes.' })
  @IsString()
  @IsOptional()
  notes?: string | null;

  @ApiPropertyOptional({ example: '2026-09-22T10:00:00.000Z' })
  @IsISO8601()
  @IsOptional()
  recordDate?: string;

  @ApiProperty({ example: 'Peso registrado con un dígito de más.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  changeReason: string;
}

export class DeleteSpecialtyRecordDto {
  @ApiProperty({ example: 'Registro cargado en el paciente equivocado.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
