import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsInt,
  Min,
  Max,
  IsEnum,
  IsBoolean,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/pagination';

export class CreateAppointmentDto {
  @ApiProperty({ example: 'patient-id' })
  @IsString()
  @IsNotEmpty()
  patientId: string;

  @ApiPropertyOptional({ example: 'professional-user-id' })
  @IsString()
  @IsOptional()
  professionalId?: string;

  @ApiPropertyOptional({ example: 'psychologist-user-id' })
  @IsString()
  @IsOptional()
  psychologistId?: string;

  @ApiPropertyOptional({ example: 'specialty-id' })
  @IsString()
  @IsOptional()
  specialtyId?: string;

  @ApiPropertyOptional({ example: 'Sesión de terapia cognitivo-conductual' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ example: 'Trabajo sobre ansiedad' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: '2024-03-15T10:00:00Z' })
  @IsDateString()
  @IsNotEmpty()
  startTime: string;

  @ApiProperty({ example: 60 })
  @IsInt()
  @Min(15)
  @Max(240)
  duration: number; // minutes

  @ApiPropertyOptional({ example: 'Consultorio 1' })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional({ example: false })
  @IsBoolean()
  @IsOptional()
  isOnline?: boolean;

  @ApiPropertyOptional({ example: 'https://zoom.us/j/123456789' })
  @IsString()
  @IsOptional()
  meetingUrl?: string;

  @ApiPropertyOptional({
    example: 'branch_cuid',
    nullable: true,
    description: 'An active branch of the clinic. Null on update removes the branch.',
  })
  @IsString()
  @IsOptional()
  branchId?: string | null;
}

export class UpdateAppointmentDto extends PartialType(CreateAppointmentDto) {
  @ApiPropertyOptional({ enum: AppointmentStatus })
  @IsEnum(AppointmentStatus)
  @IsOptional()
  status?: AppointmentStatus;
}

export class ListAppointmentsQueryDto extends PaginationQueryDto {
  @IsString() @IsOptional() professionalId?: string;
  @IsString() @IsOptional() psychologistId?: string;
  @IsString() @IsOptional() specialtyId?: string;
  @IsString() @IsOptional() branchId?: string;
  @IsString() @IsOptional() patientId?: string;
  @IsEnum(AppointmentStatus) @IsOptional() status?: AppointmentStatus;
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOptional() to?: string;
}

export class CancelAppointmentDto {
  @ApiProperty({ example: 'Paciente solicitó cancelación' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
