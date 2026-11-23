import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsDateString, IsIn } from 'class-validator';
import { MAX_SEARCH_LENGTH, PaginationQueryDto } from '../../common/pagination/pagination';

export class CreateTaskDto {
  @ApiProperty({ example: 'patient-id' })
  @IsString()
  @IsNotEmpty()
  patientId: string;

  @ApiProperty({ example: 'Enviar cuestionario de seguimiento' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: 'Enviar formulario PHQ-9 por correo' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'], example: 'MEDIUM' })
  @IsEnum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'])
  @IsOptional()
  priority?: string;

  @ApiPropertyOptional({ example: '2024-03-20T12:00:00Z' })
  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @ApiPropertyOptional({ example: 'user-id' })
  @IsString()
  @IsOptional()
  assignedToId?: string;
}

const TASK_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

/** Filters shared by the task list and its summary. */
export class TaskSummaryQueryDto {
  @ApiPropertyOptional({ example: 'patient-id' })
  @IsOptional()
  @IsString()
  patientId?: string;

  @ApiPropertyOptional({ example: 'user-id' })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES })
  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: string;

  @ApiPropertyOptional({
    maxLength: MAX_SEARCH_LENGTH,
    description:
      'Matches title, description or the patient name (case-insensitive, partial). Cut to 100 characters.',
  })
  @IsOptional()
  @IsString()
  search?: string;
}

export class ListTasksQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'patient-id' })
  @IsOptional()
  @IsString()
  patientId?: string;

  @ApiPropertyOptional({ example: 'user-id' })
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional({ enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: string;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES })
  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: string;

  @ApiPropertyOptional({
    maxLength: MAX_SEARCH_LENGTH,
    description:
      'Matches title, description or the patient name (case-insensitive, partial). Cut to 100 characters.',
  })
  @IsOptional()
  @IsString()
  search?: string;
}

export class UpdateTaskDto extends PartialType(CreateTaskDto) {
  @ApiPropertyOptional({ enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] })
  @IsEnum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({
    description: 'Fecha de completado (se establece automáticamente al completar)',
  })
  @IsDateString()
  @IsOptional()
  completedAt?: string;
}
