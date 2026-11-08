import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DemoRequestStatus } from '@prisma/client';

/** Same options as the select of the public form (web/src/features/marketing/demo-request.ts). */
export const TEAM_SIZES = ['1', '2-5', '6-15', '16+'] as const;

const trimText = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateDemoRequestDto {
  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ description: 'Name of the practice or clinic' })
  @Transform(trimText)
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  clinic: string;

  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty()
  @Transform(trimText)
  @IsString()
  @Matches(/^[+\d][\d\s-]{6,}$/)
  @MaxLength(30)
  phone: string;

  @ApiProperty({ enum: TEAM_SIZES })
  @IsIn(TEAM_SIZES)
  teamSize: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(500)
  message?: string;

  @ApiProperty({ description: 'The visitor accepted the privacy policy' })
  @IsBoolean()
  @Equals(true)
  acceptPrivacy: boolean;

  @ApiPropertyOptional({
    description: 'Honeypot: hidden from people. A request that fills it is accepted and dropped.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

export class UpdateDemoRequestDto {
  @ApiProperty({ enum: DemoRequestStatus })
  @IsIn(Object.values(DemoRequestStatus))
  status: DemoRequestStatus;
}

export class ListDemoRequestsQueryDto {
  @ApiPropertyOptional({ enum: DemoRequestStatus })
  @IsOptional()
  @IsIn(Object.values(DemoRequestStatus))
  status?: DemoRequestStatus;
}
