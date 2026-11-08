import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EncounterType } from '@prisma/client';
import { IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class StartEncounterDto {
  @ApiProperty({ enum: EncounterType, example: EncounterType.FIRST_VISIT })
  @IsEnum(EncounterType)
  encounterType: EncounterType;

  @ApiProperty({ example: 'Dolor lumbar de dos semanas de evolución.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;

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

  @ApiPropertyOptional({ example: '2026-10-03T15:00:00.000Z' })
  @IsISO8601()
  @IsOptional()
  startedAt?: string;
}

export class UpdateEncounterDto {
  @ApiPropertyOptional({ enum: EncounterType })
  @IsEnum(EncounterType)
  @IsOptional()
  encounterType?: EncounterType;

  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(2000)
  reason?: string;
}

export class CloseEncounterDto {
  @ApiPropertyOptional({ example: 'Se indica reposo relativo y control en 7 días.' })
  @IsString()
  @IsOptional()
  @MaxLength(5000)
  summary?: string;

  @ApiProperty({
    description:
      'The password of the professional: closing signs the encounter, so who signs is checked again. A wrong or missing one answers 403 SIGNATURE_PASSWORD_INVALID.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  password?: string;
}

export class DeleteEncounterDto {
  @ApiProperty({ example: 'Atención iniciada en el paciente equivocado.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
