import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { PatientFile, Prisma, SessionMediaPhase } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import {
  clinicalRecordForbidden,
  clinicalRecordNotFound,
} from '../clinical-access/clinical-errors';
import { assertOpenEncounter } from '../encounters/encounters.service';
import { PrismaService } from '../prisma/prisma.service';
import { DeletePatientFileDto, UploadPatientFileDto } from './dto/patient-file.dto';
import { FILE_STORAGE, FileStorage } from './file-storage';

export const MAX_PATIENT_FILE_BYTES = 10 * 1024 * 1024;
const BYTES_PER_GB = 1024 ** 3;

/** The types accepted, each with the bytes a real file of that type starts with. */
const FILE_SIGNATURES: Record<string, number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
};

/** Stored encrypted; everything outside this service works with the decrypted file. */
const ENCRYPTED_FILE_FIELDS = ['fileName', 'description'] as const;

const fileInclude = {
  uploadedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.PatientFileInclude;

/** A file as the API returns it: decrypted, with its uploader, never its storage key. */
export type PatientFileView = Omit<
  Prisma.PatientFileGetPayload<{ include: typeof fileInclude }>,
  'storageKey'
>;

/** What multer hands over for the uploaded part. */
export interface UploadedFilePart {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** The metadata of a file as the audit log keeps it; the bytes are never copied there. */
export function snapshotPatientFile(file: PatientFile) {
  return {
    patientId: file.patientId,
    uploadedById: file.uploadedById,
    encounterId: file.encounterId,
    category: file.category,
    fileName: file.fileName,
    description: file.description,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    treatmentSessionId: file.treatmentSessionId,
    phase: file.phase,
  };
}

const invalidFile = (message: string) =>
  new BadRequestException({ statusCode: 400, code: 'PATIENT_FILE_INVALID', message });

/** Multer decodes the name as latin1; browsers send it as UTF-8. Paths are dropped. */
function cleanFileName(original: string): string {
  const decoded = Buffer.from(original ?? '', 'latin1').toString('utf8');
  const base =
    decoded
      .split(/[\\/]/)
      .pop()
      ?.replace(/[\u0000-\u001f]/g, '')
      .trim() ?? '';
  return (base || 'archivo').slice(0, 200);
}

@Injectable()
export class PatientFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: ClinicalAuditService,
    private readonly crypto: ClinicalCryptoService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async list(tenantId: string, patientId: string, actor: ClinicalActor) {
    await this.assertPatient(tenantId, patientId);
    const stored = await this.prisma.patientFile.findMany({
      where: { tenantId, patientId, deletedAt: null },
      include: fileInclude,
      orderBy: { createdAt: 'desc' },
    });

    await this.audit.record(
      tenantId,
      actor,
      stored.map((file) => ({
        action: 'READ' as const,
        entity: 'PATIENT_FILE' as const,
        entityId: file.id,
        patientId,
      })),
    );

    return stored.map((file) => this.present(this.decrypt(file)));
  }

  async upload(
    tenantId: string,
    patientId: string,
    actor: ClinicalActor,
    part: UploadedFilePart | undefined,
    dto: UploadPatientFileDto,
    session?: { treatmentSessionId: string; phase: SessionMediaPhase },
  ): Promise<PatientFileView> {
    if (!part?.buffer?.length) throw invalidFile('No se recibió ningún archivo.');
    if (part.buffer.length > MAX_PATIENT_FILE_BYTES) {
      throw new PayloadTooLargeException({
        statusCode: 413,
        code: 'PATIENT_FILE_TOO_LARGE',
        message: 'El archivo supera los 10 MB.',
      });
    }
    // The declared type must be an accepted one and match what the bytes really are.
    const signature = FILE_SIGNATURES[part.mimetype];
    if (!signature || !signature.every((byte, index) => part.buffer[index] === byte)) {
      throw invalidFile('Solo se aceptan archivos PDF, JPG o PNG.');
    }

    await this.assertPatient(tenantId, patientId);
    if (dto.encounterId) {
      await assertOpenEncounter(this.prisma, tenantId, patientId, dto.encounterId, actor);
    }

    const storageKey = `${tenantId}/${patientId}/${randomUUID()}`;
    const sizeBytes = part.buffer.length;
    await this.storage.put(storageKey, this.crypto.encryptBuffer(tenantId, part.buffer));

    try {
      return await this.transaction(async (tx) => {
        await this.reserveSpace(tx, tenantId, actor, sizeBytes);

        const stored = await tx.patientFile.create({
          data: {
            tenantId,
            patientId,
            uploadedById: actor.userId,
            encounterId: dto.encounterId,
            category: dto.category,
            fileName: this.crypto.encrypt(tenantId, cleanFileName(part.originalname)),
            description: dto.description?.trim()
              ? this.crypto.encrypt(tenantId, dto.description.trim())
              : null,
            mimeType: part.mimetype,
            sizeBytes,
            storageKey,
            treatmentSessionId: session?.treatmentSessionId,
            phase: session?.phase,
          },
          include: fileInclude,
        });
        const file = this.decrypt(stored);

        await this.audit.record(
          tenantId,
          actor,
          [
            {
              action: 'CREATE',
              entity: 'PATIENT_FILE',
              entityId: file.id,
              patientId,
              after: snapshotPatientFile(file),
            },
          ],
          tx,
        );

        return this.present(file);
      });
    } catch (error) {
      // Nothing refers to the bytes once the row could not be written.
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }

  /** The decrypted bytes of one file. The download is audited as a read. */
  async download(tenantId: string, patientId: string, fileId: string, actor: ClinicalActor) {
    const stored = await this.prisma.patientFile.findFirst({
      where: { id: fileId, tenantId, patientId, deletedAt: null },
    });
    if (!stored) throw clinicalRecordNotFound('Archivo no encontrado');
    const file = this.decrypt(stored);

    const data = this.crypto.decryptBuffer(tenantId, await this.storage.get(file.storageKey));

    await this.audit.record(tenantId, actor, [
      { action: 'READ', entity: 'PATIENT_FILE', entityId: fileId, patientId },
    ]);

    return { fileName: file.fileName, mimeType: file.mimeType, data };
  }

  /** Soft delete by whoever uploaded it. The bytes stay for audit and keep counting as used space. */
  async delete(
    tenantId: string,
    patientId: string,
    fileId: string,
    actor: ClinicalActor,
    dto: DeletePatientFileDto,
  ) {
    return this.transaction(async (tx) => {
      const stored = await tx.patientFile.findFirst({
        where: { id: fileId, tenantId, patientId, deletedAt: null },
      });
      if (!stored) throw clinicalRecordNotFound('Archivo no encontrado');
      if (stored.uploadedById !== actor.userId) {
        throw clinicalRecordForbidden('Solo puedes eliminar los archivos que subiste');
      }

      await tx.patientFile.update({
        where: { id: fileId },
        data: {
          deletedAt: new Date(),
          deletedById: actor.userId,
          deletionReason: this.crypto.encrypt(tenantId, dto.reason),
        },
      });

      await this.audit.record(
        tenantId,
        actor,
        [
          {
            action: 'DELETE',
            entity: 'PATIENT_FILE',
            entityId: fileId,
            patientId,
            before: snapshotPatientFile(this.decrypt(stored)),
            reason: dto.reason,
          },
        ],
        tx,
      );

      return { message: 'Archivo eliminado exitosamente' };
    });
  }

  /** Space used by the clinic, for the storage page of the account holder. */
  async usage(tenantId: string) {
    const { _sum } = await this.prisma.patientFile.aggregate({
      where: { tenantId },
      _sum: { sizeBytes: true },
    });
    const attachments = _sum.sizeBytes ?? 0;
    return { total: attachments, attachments, avatars: 0, exports: 0 };
  }

  /**
   * Files of the clinic for the storage page. The name of a clinical file is clinical
   * content, so an account without an active professional profile gets it masked.
   */
  async listForAccount(tenantId: string, userId: string) {
    const [profile, stored] = await Promise.all([
      this.prisma.professionalProfile.findFirst({
        where: { userId, isActive: true, user: { tenantId, isActive: true } },
        select: { userId: true },
      }),
      this.prisma.patientFile.findMany({
        where: { tenantId, deletedAt: null },
        include: {
          ...fileInclude,
          patient: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    ]);

    return stored.map((file) => ({
      id: file.id,
      tenantId,
      fileName: profile ? this.decrypt(file).fileName : 'Archivo clínico',
      fileSize: file.sizeBytes,
      mimeType: file.mimeType,
      category: 'attachment' as const,
      relatedTo: {
        type: 'patient' as const,
        id: file.patient.id,
        name: `${file.patient.firstName} ${file.patient.lastName}`,
      },
      uploadedBy: `${file.uploadedBy.firstName} ${file.uploadedBy.lastName}`,
      createdAt: file.createdAt,
      // Clinical files are opened from the patient record, where the read is audited.
      url: '',
    }));
  }

  /** Counts the file against the plan's storage quota; every plan has a finite one. */
  private async reserveSpace(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: ClinicalActor,
    sizeBytes: number,
  ) {
    // Usage counters belong to the account: they are written under the account holder's
    // context, as patient creation does, and the caller's context is restored afterwards.
    await this.prisma.applyRlsContext(tx, { tenantId, userId: actor.userId, role: 'MASTER' });
    try {
      await this.countAgainstPlan(tx, tenantId, sizeBytes);
    } finally {
      await this.prisma.applyRlsContext(tx, { tenantId, userId: actor.userId, role: actor.role });
    }
  }

  private async countAgainstPlan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sizeBytes: number,
  ) {
    const subscription = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: { storageGB: true },
    });
    const limitBytes = (subscription?.storageGB ?? 0) * BYTES_PER_GB;

    const reserved = await tx.tenantSubscription.updateMany({
      where: { tenantId, storageUsedBytes: { lte: BigInt(limitBytes - sizeBytes) } },
      data: { storageUsedBytes: { increment: BigInt(sizeBytes) } },
    });
    if (reserved.count === 0) {
      throw new PayloadTooLargeException({
        statusCode: 413,
        code: 'STORAGE_LIMIT_REACHED',
        message: 'El consultorio alcanzó el almacenamiento de su plan.',
      });
    }
  }

  private present<T extends PatientFile>({ storageKey: _storageKey, ...file }: T) {
    return file;
  }

  private decrypt<T extends PatientFile>(file: T): T {
    return this.crypto.decryptFields(file.tenantId, file, ENCRYPTED_FILE_FIELDS);
  }

  private async assertPatient(tenantId: string, patientId: string) {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Paciente no encontrado');
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
