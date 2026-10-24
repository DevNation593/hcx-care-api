import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface PlatformAuditInput {
  tenantId: string;
  actorId: string;
  entity: 'TENANT' | 'USER' | 'PLAN';
  entityId: string;
  reason?: string;
  changes?: { before: unknown; after: unknown };
}

/** Writes the audit trail of actions a platform ADMIN performs on a clinic. */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass the transaction client to write the audit row atomically with the change it records. */
  async record(
    input: PlatformAuditInput,
    client: Pick<Prisma.TransactionClient, 'auditLog'> = this.prisma,
  ): Promise<void> {
    await client.auditLog.create({
      data: {
        tenantId: input.tenantId,
        userId: input.actorId,
        action: 'UPDATE',
        entity: input.entity,
        entityId: input.entityId,
        reason: input.reason,
        changes: input.changes as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
