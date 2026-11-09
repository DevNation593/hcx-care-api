import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SignConsentDto } from '../../treatment-sessions/dto/consent-document.dto';

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class PresentProcedureConsentDto {
  @ApiProperty({ example: 'template_cuid', description: 'A consent template of the clinic.' })
  @IsString()
  templateId: string;

  @ApiProperty({ example: 'Inserción de dispositivo intrauterino' })
  @Transform(trimText)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  procedureName: string;
}

export class SignProcedureConsentDto extends SignConsentDto {
  @ApiPropertyOptional({ example: 'María López', description: 'Who witnessed the signature.' })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(200)
  witnessName?: string;
}
