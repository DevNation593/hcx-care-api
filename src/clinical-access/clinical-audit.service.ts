import { Injectable } from '@nestjs/common';
import { AuditAction, AuditEntity, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalActor } from './clinical-actor';
import { ClinicalCryptoService } from './clinical-crypto.service';

export const CLINICAL_AUDIT_ENTITIES: readonly AuditEntity[] = [
  'CLINICAL_NOTE',
  'SPECIALTY_RECORD',
  'ENCOUNTER',
  'PATIENT_FILE',
  'TREATMENT_SESSION',
  'CONSENT_DOCUMENT',
];

export interface ClinicalAuditEntry {
  action: AuditAction;
  entity: AuditEntity;
  entityId: string;
  patientId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

type AuditDb = PrismaService | Prisma.TransactionClient;

/** Dates and other non-JSON values become their JSON form so the snapshot is stored verbatim. */
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class ClinicalAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
  ) {}

  /**
   * Pass the transaction client so a change and its audit entry commit together.
   * Snapshots and reasons hold clinical content, so they are stored encrypted.
   */
  async record(
    tenantId: string,
    actor: ClinicalActor,
    entries: ClinicalAuditEntry[],
    db: AuditDb = this.prisma,
  ): Promise<void> {
    if (entries.length === 0) return;

    await db.auditLog.createMany({
      data: entries.map(({ before, after, reason, ...entry }) => ({
        ...entry,
        tenantId,
        userId: actor.userId,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        reason: reason === undefined ? undefined : this.crypto.encrypt(tenantId, reason),
        changes:
          before === undefined && after === undefined
            ? Prisma.JsonNull
            : toJson(
                this.crypto.encryptJson(
                  tenantId,
                  toJson({ before: before ?? null, after: after ?? null }),
                ),
              ),
      })),
    });
  }
}
