import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SessionMediaPhase } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export const SESSION_MEDIA_PHASES = ['BEFORE', 'AFTER', 'OTHER'] as const;

export class CreateTreatmentSessionDto {
  @ApiProperty({ example: 'treatment_cuid', description: 'Its current version is pinned.' })
  @IsString()
  @IsNotEmpty()
  treatmentId: string;

  @ApiPropertyOptional({
    example: 'appointment_cuid',
    description:
      'The appointment being attended. It must be of the patient and of the caller, and is marked in progress.',
  })
  @IsString()
  @IsOptional()
  appointmentId?: string;

  @ApiPropertyOptional({
    example: 'branch_cuid',
    description: 'Defaults to the appointment branch.',
  })
  @IsString()
  @IsOptional()
  branchId?: string;
}

export class SaveSessionFormDto {
  @ApiProperty({
    example: { pregnant: 'NO' },
    description: 'The complete answers, validated against the form version the treatment pins.',
  })
  @IsObject()
  data: Record<string, unknown>;
}

/** The text fields that travel with a session photo in the multipart request. */
export class UploadSessionMediaDto {
  @ApiProperty({
    enum: SESSION_MEDIA_PHASES,
    example: 'BEFORE',
    description:
      'BEFORE once the consent is satisfied and before the start, AFTER while in progress, OTHER until the session ends.',
  })
  @IsIn(SESSION_MEDIA_PHASES)
  phase: SessionMediaPhase;

  @ApiPropertyOptional({ example: 'Frente, luz natural.' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;
}

export class CompleteTreatmentSessionDto {
  @ApiPropertyOptional({
    example: 'Toxina 20 U en glabela, sin incidencias.',
    description: 'Replaces the stored notes; without it the stored notes are used.',
  })
  @Transform(trimText)
  @IsString()
  @IsOptional()
  @MaxLength(10000)
  procedureNotes?: string;
}

export class CancelTreatmentSessionDto {
  @ApiProperty({ example: 'La paciente presentó una reacción vasovagal.' })
  @Transform(trimText)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}
