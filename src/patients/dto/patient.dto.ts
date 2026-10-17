import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsDateString,
  MaxLength,
} from 'class-validator';

export class CreatePatientDto {
  @ApiProperty({ example: 'Juan' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ example: 'Pérez' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiPropertyOptional({ example: 'juan.perez@email.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: '+52 555 123 4567' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: '1990-05-15' })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'Masculino', description: 'Género del paciente' })
  @IsString()
  @IsOptional()
  gender?: string;

  @ApiPropertyOptional({ example: 'Calle Principal 123' })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({ example: 'María Pérez (Madre)' })
  @IsString()
  @IsOptional()
  emergencyContact?: string;

  @ApiPropertyOptional({ example: '+52 555 987 6543' })
  @IsString()
  @IsOptional()
  emergencyPhone?: string;

  @ApiPropertyOptional({ example: 'María Pérez', description: 'Nombre del contacto de emergencia' })
  @IsString()
  @IsOptional()
  emergencyContactName?: string;

  @ApiPropertyOptional({
    example: '+52 555 111 2222',
    description: 'Teléfono del contacto de emergencia',
  })
  @IsString()
  @IsOptional()
  emergencyContactPhone?: string;

  // Identification. Format and pairing rules are enforced in the service; null or an empty
  // string clears a field. The pair is unique among the live patients of the clinic.
  @ApiPropertyOptional({
    example: 'CEDULA',
    enum: ['CEDULA', 'RUC', 'PASSPORT', 'OTHER'],
    nullable: true,
  })
  @IsString()
  @IsOptional()
  identificationType?: string | null;

  @ApiPropertyOptional({ example: '1712345678', nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(40)
  identificationNumber?: string | null;

  @ApiPropertyOptional({ example: 'Casado/a' })
  @IsString()
  @IsOptional()
  @MaxLength(60)
  maritalStatus?: string;

  @ApiPropertyOptional({ example: 'Docente' })
  @IsString()
  @IsOptional()
  @MaxLength(120)
  occupation?: string;

  @ApiPropertyOptional({ example: 'Ecuatoriana' })
  @IsString()
  @IsOptional()
  @MaxLength(80)
  nationality?: string;

  @ApiPropertyOptional({ example: 'O+' })
  @IsString()
  @IsOptional()
  @MaxLength(10)
  bloodType?: string;

  @ApiPropertyOptional({ example: 'Discapacidad auditiva 40 %' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  disability?: string;

  @ApiPropertyOptional({ example: 'Seguros del Pichincha' })
  @IsString()
  @IsOptional()
  @MaxLength(120)
  insuranceProvider?: string;

  @ApiPropertyOptional({ example: 'POL-000123' })
  @IsString()
  @IsOptional()
  @MaxLength(60)
  insurancePolicyNumber?: string;

  @ApiPropertyOptional({
    example: 'María Pérez',
    description: 'Representante legal. Obligatorio cuando el paciente es menor de edad.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(160)
  guardianName?: string;

  @ApiPropertyOptional({ example: 'Madre' })
  @IsString()
  @IsOptional()
  @MaxLength(60)
  guardianRelationship?: string;

  @ApiPropertyOptional({ example: '1709876543' })
  @IsString()
  @IsOptional()
  @MaxLength(40)
  guardianIdentification?: string;

  @ApiPropertyOptional({ example: '+593 99 123 4567' })
  @IsString()
  @IsOptional()
  @MaxLength(40)
  guardianPhone?: string;

  @ApiPropertyOptional({
    description:
      'Campo de compatibilidad: un ID no nulo asigna o reactiva al profesional en el equipo tratante; null solo borra este vínculo legado.',
    deprecated: true,
    nullable: true,
  })
  @IsString()
  @IsOptional()
  assignedPsychologistId?: string | null;

  @ApiPropertyOptional({ example: 'Alergia a penicilina' })
  @IsString()
  @IsOptional()
  allergies?: string;

  @ApiPropertyOptional({ example: 'Sertralina 50mg' })
  @IsString()
  @IsOptional()
  currentMedication?: string;

  @ApiPropertyOptional({ example: 'Notas generales sobre el paciente' })
  @IsString()
  @IsOptional()
  notes?: string;
}

export class UpdatePatientDto extends PartialType(CreatePatientDto) {}
