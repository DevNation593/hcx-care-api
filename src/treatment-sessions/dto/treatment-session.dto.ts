import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

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
