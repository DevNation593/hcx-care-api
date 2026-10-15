import { Prisma, TreatmentSession } from '@prisma/client';
import { TreatmentRequirements } from '../treatments/treatment-requirements';
import { isConsentApplicable, SessionFacts } from './session-requirements';

/**
 * Reads, inside the caller's transaction, the facts the requirements of a session are
 * evaluated on; they never come from the client. `session` is the decrypted session (its
 * `procedureNotes` in clear). The applicable consent is the newest signed document of the
 * patient for the same treatment (any version of it) that satisfies the pinned consent
 * version and validity; the session's own documents always count.
 */
export async function loadSessionFacts(
  tx: Prisma.TransactionClient,
  session: TreatmentSession,
  policy: TreatmentRequirements,
  pinnedConsentVersionId: string | null,
  now: Date,
): Promise<SessionFacts & { applicableConsentId: string | null }> {
  const hasForm = session.formRecordId
    ? (await tx.specialtyRecord.count({
        where: { id: session.formRecordId, tenantId: session.tenantId, deletedAt: null },
      })) > 0
    : false;

  const livePhotos = (phase: 'BEFORE' | 'AFTER') =>
    tx.patientFile.count({
      where: {
        tenantId: session.tenantId,
        treatmentSessionId: session.id,
        phase,
        deletedAt: null,
      },
    });
  const beforePhotos = await livePhotos('BEFORE');
  const afterPhotos = await livePhotos('AFTER');

  const applicableConsentId = await findApplicableConsent(
    tx,
    session,
    policy,
    pinnedConsentVersionId,
    now,
  );

  return {
    hasForm,
    hasApplicableConsent: applicableConsentId !== null,
    beforePhotos,
    afterPhotos,
    hasNotes: Boolean(session.procedureNotes?.trim()),
    applicableConsentId,
  };
}

async function findApplicableConsent(
  tx: Prisma.TransactionClient,
  session: TreatmentSession,
  policy: TreatmentRequirements,
  pinnedConsentVersionId: string | null,
  now: Date,
): Promise<string | null> {
  if (!policy.informedConsent.required || !pinnedConsentVersionId) return null;

  const pinned = await tx.treatmentVersion.findUnique({
    where: { id: session.treatmentVersionId },
    select: { treatmentId: true },
  });
  if (!pinned) return null;

  const signed = await tx.consentDocument.findMany({
    where: {
      tenantId: session.tenantId,
      patientId: session.patientId,
      templateVersionId: pinnedConsentVersionId,
      status: 'SIGNED',
      treatmentSession: { treatmentVersion: { treatmentId: pinned.treatmentId } },
    },
    select: {
      id: true,
      status: true,
      signedAt: true,
      templateVersionId: true,
      treatmentSessionId: true,
    },
    orderBy: { signedAt: 'desc' },
  });

  const required = {
    templateVersionId: pinnedConsentVersionId,
    validityDays: policy.informedConsent.validityDays,
  };
  const applicable = signed.find((doc) =>
    isConsentApplicable(doc, required, now, doc.treatmentSessionId === session.id),
  );
  return applicable?.id ?? null;
}
