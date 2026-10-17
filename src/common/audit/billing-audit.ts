import { AuditAction, Prisma } from '@prisma/client';

export type BillingAuditEntity =
  | 'BILLING_PROFILE'
  | 'ORDER'
  | 'PAYMENT'
  | 'CASH_REGISTER'
  | 'INVOICE_REQUEST';

export interface BillingAuditInput {
  tenantId: string;
  actorId: string;
  action: AuditAction;
  entity: BillingAuditEntity;
  entityId: string;
  changes?: unknown;
  reason?: string;
}

/**
 * Writes one audit row of the billing flow. Pass the transaction client so the row commits
 * atomically with the change it records.
 */
export async function recordBillingAudit(
  client: Pick<Prisma.TransactionClient, 'auditLog'>,
  input: BillingAuditInput,
): Promise<void> {
  await client.auditLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.actorId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      reason: input.reason,
      changes: input.changes as Prisma.InputJsonValue | undefined,
    },
  });
}
