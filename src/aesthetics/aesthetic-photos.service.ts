import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AestheticPhotoPhase, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { UploadedFilePart } from '../patient-files/patient-files.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const BYTES_PER_GB = 1024 ** 3;
const signatures: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
};

interface PhotoActor {
  userId: string;
  role: string;
}

@Injectable()
export class AestheticPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async list(tenantId: string, sessionId: string) {
    await this.assertSession(tenantId, sessionId);
    return this.prisma.aestheticPhoto.findMany({
      where: { tenantId, sessionId, deletedAt: null },
      select: {
        id: true,
        sessionId: true,
        phase: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async upload(
    tenantId: string,
    sessionId: string,
    phase: AestheticPhotoPhase,
    part: UploadedFilePart | undefined,
    actor: PhotoActor,
  ) {
    if (!part?.buffer?.length) throw new BadRequestException('No se recibió ninguna foto.');
    if (part.buffer.length > MAX_PHOTO_BYTES) {
      throw new PayloadTooLargeException({
        code: 'AESTHETIC_PHOTO_TOO_LARGE',
        message: 'La foto supera los 10 MB.',
      });
    }
    const signature = signatures[part.mimetype];
    if (!signature || !signature.every((byte, index) => part.buffer[index] === byte)) {
      throw new BadRequestException('Solo se aceptan fotos JPG o PNG.');
    }
    if (!this.crypto.enabled) {
      throw new ServiceUnavailableException('La clave de cifrado no está configurada.');
    }
    await this.assertSession(tenantId, sessionId);

    const storageKey = `${tenantId}/aesthetics/${sessionId}/${randomUUID()}`;
    const sizeBytes = part.buffer.length;
    await this.storage.put(storageKey, this.crypto.encryptBuffer(tenantId, part.buffer));
    try {
      const row = await runSerializableTransaction(
        this.prisma,
        tenantId,
        actor.userId,
        async (tx) => {
          await this.reserveSpace(tx, tenantId, actor, sizeBytes);
          return tx.aestheticPhoto.create({
            data: {
              tenantId,
              sessionId,
              uploadedById: actor.userId,
              phase,
              mimeType: part.mimetype,
              sizeBytes,
              storageKey,
            },
          });
        },
      );
      return this.present(row);
    } catch (error) {
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async download(tenantId: string, sessionId: string, photoId: string) {
    const row = await this.prisma.aestheticPhoto.findFirst({
      where: { id: photoId, tenantId, sessionId, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Foto no encontrada');
    const data = this.crypto.decryptBuffer(tenantId, await this.storage.get(row.storageKey));
    return { mimeType: row.mimeType, data };
  }

  async remove(tenantId: string, sessionId: string, photoId: string) {
    const result = await this.prisma.aestheticPhoto.updateMany({
      where: { id: photoId, tenantId, sessionId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('Foto no encontrada');
    return { deleted: true };
  }

  private async assertSession(tenantId: string, id: string) {
    const row = await this.prisma.aestheticSession.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Sesión no encontrada');
  }

  private async reserveSpace(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: PhotoActor,
    sizeBytes: number,
  ) {
    const subscription = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: { storageGB: true },
    });
    if (!subscription) throw new NotFoundException('Suscripción no encontrada');
    const limitBytes = subscription.storageGB * BYTES_PER_GB;
    await this.prisma.applyRlsContext(tx, { tenantId, userId: actor.userId, role: 'MASTER' });
    try {
      const reserved = await tx.tenantSubscription.updateMany({
        where: {
          tenantId,
          ...(limitBytes > 0 ? { storageUsedBytes: { lte: BigInt(limitBytes - sizeBytes) } } : {}),
        },
        data: { storageUsedBytes: { increment: BigInt(sizeBytes) } },
      });
      if (!reserved.count) {
        throw new PayloadTooLargeException({
          code: 'STORAGE_LIMIT_REACHED',
          message: 'El estudio alcanzó el almacenamiento de su plan.',
        });
      }
    } finally {
      await this.prisma.applyRlsContext(tx, { tenantId, userId: actor.userId, role: actor.role });
    }
  }

  private present<T extends { storageKey: string }>(row: T): Omit<T, 'storageKey'> {
    const { storageKey: _, ...publicRow } = row;
    return publicRow;
  }
}
