import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ClinicalFollowUpStatus,
  ClinicalOrderPriority,
  ClinicalOrderType,
  PatientContactChannel,
  ResultReviewDecision,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** Every command on an order or a follow-up names the version it was looking at. */
class VersionedDto {
  @ApiProperty({
    example: 1,
    description:
      'The version the client read. 409 CLINICAL_ORDER_VERSION_CONFLICT when it changed.',
  })
  @IsInt()
  @Min(1)
  version: number;
}

export class CreateClinicalOrderDto {
  @ApiProperty({ enum: ClinicalOrderType, example: ClinicalOrderType.LABORATORY })
  @IsEnum(ClinicalOrderType)
  orderType: ClinicalOrderType;

  @ApiProperty({ example: 'Citología cervicovaginal en base líquida' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  studyName: string;

  @ApiPropertyOptional({ example: 'Tamizaje según plan acordado con la paciente.' })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  indication?: string;

  @ApiPropertyOptional({ enum: ClinicalOrderPriority, default: ClinicalOrderPriority.ROUTINE })
  @IsEnum(ClinicalOrderPriority)
  @IsOptional()
  priority?: ClinicalOrderPriority;

  @ApiPropertyOptional({ example: 'Laboratorio Central' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  provider?: string;

  @ApiPropertyOptional({
    example: '2026-11-25T00:00:00.000Z',
    description:
      'When a result is expected. Defaults to the clinic setting (orderResultAlertDays after the order).',
  })
  @IsISO8601()
  @IsOptional()
  resultDueAt?: string;

  @ApiPropertyOptional({
    example: 'encounter_cuid',
    description:
      'An open encounter of the caller with the patient. The order is then signed when the encounter closes; without one it is signed now and the password is required.',
  })
  @IsString()
  @IsOptional()
  encounterId?: string;

  @ApiPropertyOptional({ description: 'Required without an encounter: saving signs the order.' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  password?: string;
}

export class CollectSampleDto extends VersionedDto {
  @ApiPropertyOptional({ example: '2026-11-08T15:00:00.000Z' })
  @IsISO8601()
  @IsOptional()
  collectedAt?: string;

  @ApiPropertyOptional({ example: 'Muestra de endocérvix y exocérvix.' })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}

export class SendToLabDto extends VersionedDto {
  @ApiPropertyOptional({ example: '2026-11-08T17:00:00.000Z' })
  @IsISO8601()
  @IsOptional()
  sentAt?: string;

  @ApiPropertyOptional({ example: 'Laboratorio Central' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  provider?: string;

  @ApiPropertyOptional({ example: 'LC-2026-00123', description: 'The folio the laboratory gave.' })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  externalReference?: string;
}

export class AddClinicalResultDto extends VersionedDto {
  @ApiPropertyOptional({
    example: 'Negativo para lesión intraepitelial o malignidad.',
    description: 'The report as the laboratory wrote it. A content or a file is required.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(20000)
  content?: string;

  @ApiPropertyOptional({ description: 'A file of the same patient holding the report.' })
  @IsString()
  @IsOptional()
  fileId?: string;

  @ApiPropertyOptional({ description: 'The structured record of the study, of the same patient.' })
  @IsString()
  @IsOptional()
  recordId?: string;

  @ApiPropertyOptional({ example: 'Laboratorio Central — Dra. Pérez' })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  issuedBy?: string;

  @ApiPropertyOptional({ example: '2026-11-06T00:00:00.000Z' })
  @IsISO8601()
  @IsOptional()
  studyDate?: string;

  @ApiPropertyOptional({ example: '2026-11-08T12:00:00.000Z', description: 'Defaults to now.' })
  @IsISO8601()
  @IsOptional()
  receivedAt?: string;
}

export class FollowUpInputDto {
  @ApiProperty({ example: 'Repetir citología' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: '2027-05-08T00:00:00.000Z' })
  @IsISO8601()
  dueDate: string;

  @ApiPropertyOptional({
    description: 'A professional of the clinic with an active profile. Defaults to the caller.',
  })
  @IsString()
  @IsOptional()
  assignedToId?: string;
}

export class ReviewClinicalResultDto {
  @ApiProperty({ enum: ResultReviewDecision })
  @IsEnum(ResultReviewDecision)
  decision: ResultReviewDecision;

  @ApiProperty({ example: 'Resultado sin hallazgos. Control según plan preventivo.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  note: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  appointmentNeeded?: boolean;

  @ApiPropertyOptional({
    type: FollowUpInputDto,
    description: 'Required when the decision is a follow-up or a repetition.',
  })
  @ValidateNested()
  @Type(() => FollowUpInputDto)
  @IsOptional()
  followUp?: FollowUpInputDto;
}

export class RecordCommunicationDto {
  @ApiProperty({ enum: PatientContactChannel })
  @IsEnum(PatientContactChannel)
  channel: PatientContactChannel;

  @ApiPropertyOptional({ example: 'Se explicó el resultado en consulta.' })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ example: '2026-11-09T15:00:00.000Z', description: 'Defaults to now.' })
  @IsISO8601()
  @IsOptional()
  communicatedAt?: string;
}

export class CompleteClinicalOrderDto extends VersionedDto {
  @ApiPropertyOptional({
    description:
      'Required when the patient was not contacted about the last result: why the order is closed anyway.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  note?: string;
}

export const ORDER_END_STATUSES = ['CANCELLED', 'NOT_PERFORMED'] as const;

export class CancelClinicalOrderDto extends VersionedDto {
  @ApiProperty({ enum: ORDER_END_STATUSES, example: 'CANCELLED' })
  @IsIn(ORDER_END_STATUSES)
  status: (typeof ORDER_END_STATUSES)[number];

  @ApiProperty({ example: 'La paciente decidió no realizar el estudio.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;
}

export class CreateClinicalFollowUpDto extends FollowUpInputDto {}

export class UpdateClinicalFollowUpDto extends VersionedDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsISO8601()
  @IsOptional()
  dueDate?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  assignedToId?: string;
}

export const FOLLOW_UP_CLOSING_STATUSES = [
  ClinicalFollowUpStatus.DONE,
  ClinicalFollowUpStatus.CANCELLED,
] as const;

export class CloseClinicalFollowUpDto extends VersionedDto {
  @ApiProperty({ enum: FOLLOW_UP_CLOSING_STATUSES })
  @IsIn(FOLLOW_UP_CLOSING_STATUSES)
  status: (typeof FOLLOW_UP_CLOSING_STATUSES)[number];

  @ApiProperty({ example: 'Se realizó la citología de control.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note: string;
}

export const INBOX_SCOPES = ['mine', 'all'] as const;
export type InboxScope = (typeof INBOX_SCOPES)[number];

export class ClinicalInboxQueryDto {
  @ApiPropertyOptional({
    enum: INBOX_SCOPES,
    default: 'mine',
    description: 'mine: orders the caller placed and follow-ups assigned to them. all: the clinic.',
  })
  @IsIn(INBOX_SCOPES)
  @IsOptional()
  scope?: InboxScope;
}

export class ListFollowUpsQueryDto extends ClinicalInboxQueryDto {
  @ApiPropertyOptional({ enum: ClinicalFollowUpStatus, default: ClinicalFollowUpStatus.OPEN })
  @IsEnum(ClinicalFollowUpStatus)
  @IsOptional()
  status?: ClinicalFollowUpStatus;
}
