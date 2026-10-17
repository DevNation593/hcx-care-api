import { BadRequestException, ConflictException, HttpException, Injectable } from '@nestjs/common';
import { SessionMediaPhase, TreatmentSession } from '@prisma/client';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import {
  PatientFilesService,
  PatientFileView,
  UploadedFilePart,
} from '../patient-files/patient-files.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionCommand } from './session-state';
import { stripJpegMetadata } from './strip-jpeg-metadata';
import { TreatmentSessionsService } from './treatment-sessions.service';

const UPLOAD_COMMANDS: Record<SessionMediaPhase, SessionCommand> = {
  BEFORE: 'UPLOAD_BEFORE',
  AFTER: 'UPLOAD_AFTER',
  OTHER: 'UPLOAD_OTHER',
};

/** Before and after photos are pictures; any other file of the session may also be a PDF. */
const PHOTO_TYPES = ['image/jpeg', 'image/png'];

const invalidFile = (message: string) =>
  new BadRequestException({ statusCode: 400, code: 'PATIENT_FILE_INVALID', message });

const isInvalidTransition = (error: unknown) =>
  error instanceof HttpException &&
  (error.getResponse() as { code?: string }).code === 'TREATMENT_SESSION_INVALID_TRANSITION';

/**
 * Photos and files of a treatment session, by phase. They are stored as clinical files of the
 * patient in the session's encounter; JPEGs lose their EXIF/XMP segments first.
 */
@Injectable()
export class SessionMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: TreatmentSessionsService,
    private readonly files: PatientFilesService,
  ) {}

  async upload(
    tenantId: string,
    sessionId: string,
    actor: ClinicalActor,
    part: UploadedFilePart | undefined,
    dto: { phase: SessionMediaPhase; description?: string },
  ): Promise<PatientFileView> {
    const session = await this.sessionTakingPhase(tenantId, sessionId, actor, dto.phase);

    if (part && dto.phase !== 'OTHER' && !PHOTO_TYPES.includes(part.mimetype)) {
      throw invalidFile('Las fotos deben ser JPG o PNG.');
    }

    return this.files.upload(
      tenantId,
      session.patientId,
      actor,
      part?.buffer?.length && part.mimetype === 'image/jpeg' ? withoutMetadata(part) : part,
      { category: 'IMAGEN', description: dto.description, encounterId: session.encounterId },
      { treatmentSessionId: session.id, phase: dto.phase },
    );
  }

  /** The session, when its professional may add a file of this phase in its current state. */
  private sessionTakingPhase(
    tenantId: string,
    sessionId: string,
    actor: ClinicalActor,
    phase: SessionMediaPhase,
  ): Promise<TreatmentSession> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      try {
        const { session } = await this.sessions.loadForCommand(
          tx,
          tenantId,
          sessionId,
          actor,
          UPLOAD_COMMANDS[phase],
        );
        return session;
      } catch (error) {
        if (!isInvalidTransition(error)) throw error;
        const { status } = (error as HttpException).getResponse() as { status?: string };
        throw new ConflictException({
          statusCode: 409,
          code: 'SESSION_PHOTO_PHASE_NOT_ALLOWED',
          message: 'La atención no admite archivos de esta fase en su estado actual.',
          status,
          phase,
        });
      }
    });
  }
}

/** The part with the APP1 segments of its JPEG removed; a JPEG that cannot be read is refused. */
function withoutMetadata(part: UploadedFilePart): UploadedFilePart {
  let buffer: Buffer;
  try {
    buffer = stripJpegMetadata(part.buffer);
  } catch (error) {
    if ((error as Error).message !== 'MALFORMED_JPEG') throw error;
    throw invalidFile('La imagen JPG está dañada o incompleta.');
  }
  return { ...part, buffer, size: buffer.length };
}
