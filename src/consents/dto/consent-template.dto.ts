import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class SaveConsentDraftDto {
  @ApiProperty({ example: 'Consentimiento informado para toxina botulínica' })
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title: string;

  @ApiProperty({
    example: 'Yo, {{paciente}}, con identificación {{identificacion}}, autorizo {{tratamiento}}.',
    description:
      'Text the patient signs. Variables: {{paciente}}, {{identificacion}}, {{tratamiento}}, {{profesional}}, {{fecha}}.',
  })
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  body: string;
}

export class CreateConsentTemplateDto extends SaveConsentDraftDto {
  @ApiProperty({ example: 'Toxina botulínica' })
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;
}
