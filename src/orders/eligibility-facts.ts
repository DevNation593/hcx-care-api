import { NotFoundException } from '@nestjs/common';
import {
  Patient,
  Prisma,
  TreatmentSession,
  TreatmentSessionStatus,
  TreatmentVersion,
} from '@prisma/client';
import { loadSessionFacts } from '../treatment-sessions/session-facts';
import { parseTreatmentRequirements } from '../treatments/treatment-requirements';
import { OrderBillingFacts, SessionBillingFacts } from './billing-eligibility';

/** Statuses of a session that can no longer be invoiced. */
export const NOT_BILLABLE_SESSION_STATUSES: TreatmentSessionStatus[] = [
  'CANCELLED',
  'NO_SHOW',
  'CONSENT_REFUSED',
  'CONSENT_REVOKED',
  'BILLING_PENDING',
  'BILLED',
];

/** A session the cash desk may still add to an order; it carries no clinical content. */
export interface BillableSession {
  id: string;
  status: TreatmentSessionStatus;
  createdAt: string;
  completedAt: string | null;
  branchId: string | null;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    identificationNumber: string | null;
  };
  treatment: { id: string; name: string; version: number };
  price: string;
  taxRatePercent: string;
  compliant: boolean;
}

export type SessionForBilling = TreatmentSession & {
  treatmentVersion: TreatmentVersion;
  patient: Pick<Patient, 'firstName' | 'lastName'>;
};

/**
 * Server-side facts RN-10 evaluates for one session. Nothing comes from the client. The
 * session does not need to be decrypted: only the form and the consent are read.
 */
export async function loadSessionBillingFacts(
  tx: Prisma.TransactionClient,
  session: SessionForBilling,
  itemId: string,
  now: Date,
): Promise<SessionBillingFacts> {
  const version = session.treatmentVersion;
  const policy = parseTreatmentRequirements(version.requirements);
  const facts = await loadSessionFacts(tx, session, policy, version.consentTemplateVersionId, now);

  // A started session pinned its consent at start: revoking it later does not undo the care.
  const hasApplicableConsent =
    session.startedAt !== null
      ? !policy.informedConsent.required || session.consentDocumentId !== null
      : facts.hasApplicableConsent;

  return {
    itemId,
    patientName: `${session.patient.firstName} ${session.patient.lastName}`,
    status: session.status,
    policy,
    hasForm: facts.hasForm,
    hasApplicableConsent,
    completed: session.completedAt !== null,
  };
}

/** Facts of the live items of an order and of its cash side; `invoicingConfigured` is not evaluated. */
export async function loadOrderBillingFacts(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
  now: Date,
): Promise<OrderBillingFacts> {
  const order = await tx.order.findFirst({
    where: { id: orderId, tenantId },
    include: {
      items: { where: { releasedAt: null }, orderBy: { createdAt: 'asc' } },
      billingProfile: { select: { isActive: true, idType: true } },
    },
  });
  if (!order) {
    throw new NotFoundException({
      statusCode: 404,
      code: 'ORDER_NOT_FOUND',
      message: 'Orden no encontrada.',
    });
  }

  const sessionIds = order.items.flatMap((item) =>
    item.treatmentSessionId ? [item.treatmentSessionId] : [],
  );
  const sessions = sessionIds.length
    ? await tx.treatmentSession.findMany({
        where: { id: { in: sessionIds }, tenantId },
        include: {
          treatmentVersion: true,
          patient: { select: { firstName: true, lastName: true } },
        },
      })
    : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));

  const sessionFacts: SessionBillingFacts[] = [];
  for (const item of order.items) {
    const session = item.treatmentSessionId ? byId.get(item.treatmentSessionId) : undefined;
    if (session) sessionFacts.push(await loadSessionBillingFacts(tx, session, item.id, now));
  }

  return {
    sessions: sessionFacts,
    itemCount: order.items.length,
    total: new Prisma.Decimal(order.total),
    paidTotal: new Prisma.Decimal(order.paidTotal),
    profile: order.billingProfile,
    invoicingConfigured: !!(await tx.branchEmissionPoint.findFirst({
      where: { branchId: order.branchId, connection: { tenantId, active: true } },
    })),
  };
}
