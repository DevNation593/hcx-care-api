import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsInt,
  IsBoolean,
  IsArray,
  Min,
  Max,
  Matches,
  ArrayMinSize,
} from 'class-validator';

export class UpdateTenantSettingsDto {
  @ApiPropertyOptional({ example: 'Clínica Integral S.A.' })
  @IsString()
  @IsOptional()
  legalName?: string;

  @ApiPropertyOptional({ example: 'RUC', enum: ['RUC', 'CEDULA', 'PASSPORT'] })
  @IsString()
  @IsOptional()
  taxIdentificationType?: string;

  @ApiPropertyOptional({ example: '1790012345001' })
  @IsString()
  @IsOptional()
  taxIdentificationNumber?: string;

  // Working hours
  @ApiPropertyOptional({
    example: '09:00',
    description: 'Start of working hours in HH:mm format',
  })
  @IsString()
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'La hora de inicio de la jornada debe tener el formato HH:mm (por ejemplo, 08:00).',
  })
  workingHoursStart?: string;

  @ApiPropertyOptional({
    example: '18:00',
    description: 'End of working hours in HH:mm format',
  })
  @IsString()
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'La hora de fin de la jornada debe tener el formato HH:mm (por ejemplo, 18:30).',
  })
  workingHoursEnd?: string;

  @ApiPropertyOptional({
    example: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'],
    description: 'Working days of the week',
  })
  @IsArray()
  @IsOptional()
  @ArrayMinSize(1)
  @IsString({ each: true })
  workingDays?: string[];

  // Appointment settings
  @ApiPropertyOptional({
    example: 60,
    description: 'Default appointment duration in minutes',
  })
  @IsInt()
  @IsOptional()
  @Min(15)
  @Max(240)
  defaultAppointmentDuration?: number;

  @ApiPropertyOptional({
    example: false,
    description: 'Allow overlapping appointments for same psychologist',
  })
  @IsBoolean()
  @IsOptional()
  allowDoubleBooking?: boolean;

  // Reminder settings
  @ApiPropertyOptional({
    example: ['24h', '2h'],
    description: 'Reminder rules (e.g., "24h", "2h", "30m")',
  })
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  @Matches(/^\d+(h|m)$/, {
    each: true,
    message:
      'Cada recordatorio debe usar el formato "<número>h" o "<número>m" (por ejemplo, "24h" o "30m").',
  })
  reminderRules?: string[];

  @ApiPropertyOptional({ example: true, description: 'Enable/disable reminders' })
  @IsBoolean()
  @IsOptional()
  reminderEnabled?: boolean;

  // Clinical inbox thresholds, decided by the clinic.
  @ApiPropertyOptional({
    example: 3,
    description: 'Days a received result may wait for review before it shows as overdue',
  })
  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(90)
  resultReviewAlertDays?: number;

  @ApiPropertyOptional({
    example: 15,
    description: 'Days an order may wait for its result before it shows as overdue',
  })
  @IsInt()
  @IsOptional()
  @Min(1)
  @Max(365)
  orderResultAlertDays?: number;
  @ApiPropertyOptional({
    example: true,
    description: 'Require two-factor sign-in for the account holder and the professionals',
  })
  @IsBoolean()
  @IsOptional()
  requireMfa?: boolean;

  // Locale & timezone
  @ApiPropertyOptional({
    example: 'America/Mexico_City',
    description: 'Timezone for the clinic',
  })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({
    example: 'es-MX',
    description: 'Locale for formatting',
  })
  @IsString()
  @IsOptional()
  locale?: string;
}
