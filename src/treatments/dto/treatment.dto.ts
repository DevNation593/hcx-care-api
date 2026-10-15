import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Only the shape is checked here. The ranges, the references to forms and consents and the
 * requirements document are validated together by the service, which reports every issue at
 * once as 400 TREATMENT_REQUIREMENTS_INVALID.
 */
export class TreatmentVersionDto {
  @ApiProperty({ example: 120.5, description: 'Between 0 and 999999.99, two decimals.' })
  @IsNumber()
  price: number;

  @ApiProperty({ example: 12, description: 'Between 0 and 100, two decimals.' })
  @IsNumber()
  taxRatePercent: number;

  @ApiProperty({ example: 45, description: 'Whole minutes, between 5 and 1440.' })
  @IsInt()
  durationMinutes: number;

  @ApiPropertyOptional({ nullable: true, description: 'Medical form; needs formVersion.' })
  @IsOptional()
  @IsString()
  formDefinitionId?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 1 })
  @IsOptional()
  @IsInt()
  formVersion?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Published consent template version; needs informedConsent.required.',
  })
  @IsOptional()
  @IsString()
  consentTemplateVersionId?: string | null;

  @ApiPropertyOptional({
    description:
      'medicalForm, informedConsent, photos and clinicalNotes; missing keys take their defaults.',
    example: {
      medicalForm: { required: true },
      informedConsent: { required: true, validityDays: 365 },
      photos: { minimumBefore: 1, minimumAfter: 1 },
      clinicalNotes: { requiredForCompletion: true },
    },
  })
  @IsOptional()
  @IsObject()
  requirements?: unknown;
}

export class CreateTreatmentDto {
  @ApiProperty({ example: 'Toxina botulínica' })
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: 'Medicina estética' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @ApiPropertyOptional({
    description: 'One of the clinic specialties; empty for any professional.',
  })
  @IsOptional()
  @IsString()
  specialtyId?: string;

  @ApiProperty({ type: TreatmentVersionDto, description: 'Becomes version 1.' })
  // ValidateNested skips undefined, so the presence is checked on its own.
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => TreatmentVersionDto)
  version: TreatmentVersionDto;
}

export class UpdateTreatmentDto {
  @ApiPropertyOptional()
  @Transform(trimText)
  @ValidateIf((_, value) => value !== undefined) // null is not a name
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Null lets any professional open sessions.' })
  @IsOptional()
  @IsString()
  specialtyId?: string | null;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined) // null is not a state
  @IsBoolean()
  isActive?: boolean;
}
