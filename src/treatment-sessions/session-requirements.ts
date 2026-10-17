import { UnprocessableEntityException } from '@nestjs/common';
import { ConsentDocumentStatus } from '@prisma/client';
import { TreatmentRequirements } from '../treatments/treatment-requirements';

export type MissingRequirement =
  | 'FINALIZED_MEDICAL_FORM'
  | 'SIGNED_APPLICABLE_CONSENT'
  | 'BEFORE_PHOTOS'
  | 'CLINICAL_NOTES'
  | 'AFTER_PHOTOS';

export interface SessionFacts {
  hasForm: boolean;
  hasApplicableConsent: boolean;
  beforePhotos: number;
  afterPhotos: number;
  hasNotes: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What is still missing to start the session and to complete it, in a stable order. */
export function evaluateSession(
  policy: TreatmentRequirements,
  facts: SessionFacts,
): { start: MissingRequirement[]; complete: MissingRequirement[] } {
  const start: MissingRequirement[] = [];
  const complete: MissingRequirement[] = [];

  if (policy.medicalForm.required && !facts.hasForm) start.push('FINALIZED_MEDICAL_FORM');
  if (policy.informedConsent.required && !facts.hasApplicableConsent)
    start.push('SIGNED_APPLICABLE_CONSENT');
  if (facts.beforePhotos < policy.photos.minimumBefore) start.push('BEFORE_PHOTOS');

  if (policy.clinicalNotes.requiredForCompletion && !facts.hasNotes)
    complete.push('CLINICAL_NOTES');
  if (facts.afterPhotos < policy.photos.minimumAfter) complete.push('AFTER_PHOTOS');

  return { start, complete };
}

/**
 * A consent satisfies the requirement when it is signed for the required template version and
 * either belongs to this session or is still within the validity window (boundary inclusive).
 */
export function isConsentApplicable(
  doc: { status: ConsentDocumentStatus; signedAt: Date | null; templateVersionId: string },
  required: { templateVersionId: string; validityDays: number | null },
  now: Date,
  sameSession: boolean,
): boolean {
  if (doc.status !== 'SIGNED' || doc.templateVersionId !== required.templateVersionId) return false;
  if (sameSession) return true;
  if (required.validityDays === null || doc.signedAt === null) return false;
  return now.getTime() - doc.signedAt.getTime() <= required.validityDays * DAY_MS;
}

export function requirementsMissing(missing: MissingRequirement[]): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'TREATMENT_REQUIREMENTS_MISSING',
    message: 'La atención no cumple los requisitos del tratamiento.',
    missing,
  });
}
