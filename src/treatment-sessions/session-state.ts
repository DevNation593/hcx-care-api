import { ConflictException } from '@nestjs/common';
import { TreatmentSessionStatus } from '@prisma/client';
import { TreatmentRequirements } from '../treatments/treatment-requirements';

export type SessionCommand =
  | 'SAVE_FORM'
  | 'PRESENT_CONSENT'
  | 'SIGN_CONSENT'
  | 'REFUSE_CONSENT'
  | 'REVOKE_CONSENT'
  | 'UPLOAD_BEFORE'
  | 'UPLOAD_AFTER'
  | 'UPLOAD_OTHER'
  | 'START'
  | 'COMPLETE'
  | 'CANCEL'
  | 'NO_SHOW';

export const TERMINAL_SESSION_STATUSES: readonly TreatmentSessionStatus[] = [
  'CLINICAL_COMPLETE',
  'CONSENT_REFUSED',
  'CONSENT_REVOKED',
  'CANCELLED',
  'NO_SHOW',
];

/** Commands the session accepts in the given status; the single source of truth for transitions. */
export function allowedCommands(
  status: TreatmentSessionStatus,
  policy: TreatmentRequirements,
): SessionCommand[] {
  const consentRequired = policy.informedConsent.required;
  switch (status) {
    case 'INTAKE_IN_PROGRESS':
      return ['SAVE_FORM', 'UPLOAD_OTHER', 'CANCEL', 'NO_SHOW'];
    case 'READY_FOR_CONSENT':
      return consentRequired
        ? [
            'SAVE_FORM',
            'PRESENT_CONSENT',
            'SIGN_CONSENT',
            'REFUSE_CONSENT',
            'UPLOAD_OTHER',
            'CANCEL',
            'NO_SHOW',
          ]
        : ['SAVE_FORM', 'UPLOAD_OTHER', 'CANCEL', 'NO_SHOW', 'UPLOAD_BEFORE', 'START'];
    case 'CONSENTED':
      return [
        'SAVE_FORM',
        'REVOKE_CONSENT',
        'UPLOAD_BEFORE',
        'UPLOAD_OTHER',
        'START',
        'CANCEL',
        'NO_SHOW',
      ];
    case 'IN_PROGRESS':
      return ['UPLOAD_AFTER', 'UPLOAD_OTHER', 'COMPLETE', 'CANCEL'];
    default:
      return [];
  }
}

/** Throws 409 TREATMENT_SESSION_INVALID_TRANSITION when the command is not allowed in the status. */
export function assertCommandAllowed(
  status: TreatmentSessionStatus,
  command: SessionCommand,
  policy: TreatmentRequirements,
): void {
  if (!allowedCommands(status, policy).includes(command)) {
    throw new ConflictException({
      statusCode: 409,
      code: 'TREATMENT_SESSION_INVALID_TRANSITION',
      message: 'La acción no está permitida en el estado actual de la atención.',
      status,
      command,
    });
  }
}

/** Where a session stands once its intake facts are known. */
export function statusAfterIntake(
  policy: TreatmentRequirements,
  facts: { hasForm: boolean; hasApplicableConsent: boolean },
): 'INTAKE_IN_PROGRESS' | 'READY_FOR_CONSENT' | 'CONSENTED' {
  if (policy.medicalForm.required && !facts.hasForm) return 'INTAKE_IN_PROGRESS';
  if (policy.informedConsent.required && facts.hasApplicableConsent) return 'CONSENTED';
  return 'READY_FOR_CONSENT';
}
