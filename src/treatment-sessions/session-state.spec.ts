import { TreatmentSessionStatus } from '@prisma/client';
import { DEFAULT_REQUIREMENTS, TreatmentRequirements } from '../treatments/treatment-requirements';
import {
  allowedCommands,
  assertCommandAllowed,
  SessionCommand,
  statusAfterIntake,
  TERMINAL_SESSION_STATUSES,
} from './session-state';

const withConsent: TreatmentRequirements = {
  ...DEFAULT_REQUIREMENTS,
  informedConsent: { required: true, validityDays: null },
};
const withoutConsent = DEFAULT_REQUIREMENTS;

const COMMANDS: SessionCommand[] = [
  'SAVE_FORM',
  'PRESENT_CONSENT',
  'SIGN_CONSENT',
  'REFUSE_CONSENT',
  'REVOKE_CONSENT',
  'UPLOAD_BEFORE',
  'UPLOAD_AFTER',
  'UPLOAD_OTHER',
  'START',
  'COMPLETE',
  'CANCEL',
  'NO_SHOW',
];

const WITH_CONSENT: Record<TreatmentSessionStatus, SessionCommand[]> = {
  INTAKE_IN_PROGRESS: ['SAVE_FORM', 'UPLOAD_OTHER', 'CANCEL', 'NO_SHOW'],
  READY_FOR_CONSENT: [
    'SAVE_FORM',
    'PRESENT_CONSENT',
    'SIGN_CONSENT',
    'REFUSE_CONSENT',
    'UPLOAD_OTHER',
    'CANCEL',
    'NO_SHOW',
  ],
  CONSENTED: [
    'SAVE_FORM',
    'REVOKE_CONSENT',
    'UPLOAD_BEFORE',
    'UPLOAD_OTHER',
    'START',
    'CANCEL',
    'NO_SHOW',
  ],
  IN_PROGRESS: ['UPLOAD_AFTER', 'UPLOAD_OTHER', 'COMPLETE', 'CANCEL'],
  CLINICAL_COMPLETE: [],
  CONSENT_REFUSED: [],
  CONSENT_REVOKED: [],
  CANCELLED: [],
  NO_SHOW: [],
  BILLING_PENDING: [],
  BILLED: [],
  BILLING_FAILED: [],
};

const WITHOUT_CONSENT: Record<TreatmentSessionStatus, SessionCommand[]> = {
  ...WITH_CONSENT,
  READY_FOR_CONSENT: ['SAVE_FORM', 'UPLOAD_OTHER', 'CANCEL', 'NO_SHOW', 'UPLOAD_BEFORE', 'START'],
};

const STATUSES = Object.keys(WITH_CONSENT) as TreatmentSessionStatus[];

describe('allowedCommands', () => {
  describe.each([
    ['with consent', withConsent, WITH_CONSENT],
    ['without consent', withoutConsent, WITHOUT_CONSENT],
  ])('%s', (_label, policy, table) => {
    it.each(STATUSES.flatMap((s) => COMMANDS.map((c) => [s, c] as const)))(
      '%s x %s',
      (status, command) => {
        expect(allowedCommands(status, policy).includes(command)).toBe(
          table[status].includes(command),
        );
      },
    );

    it.each(STATUSES)('%s lists exactly the table commands', (status) => {
      expect([...allowedCommands(status, policy)].sort()).toEqual([...table[status]].sort());
    });
  });

  it('lists commands in the order of the transition table', () => {
    expect(allowedCommands('READY_FOR_CONSENT', withoutConsent)).toEqual([
      'SAVE_FORM',
      'UPLOAD_OTHER',
      'CANCEL',
      'NO_SHOW',
      'UPLOAD_BEFORE',
      'START',
    ]);
    expect(allowedCommands('CONSENTED', withConsent)).toEqual([
      'SAVE_FORM',
      'REVOKE_CONSENT',
      'UPLOAD_BEFORE',
      'UPLOAD_OTHER',
      'START',
      'CANCEL',
      'NO_SHOW',
    ]);
  });

  it('has no command in any terminal status', () => {
    expect([...TERMINAL_SESSION_STATUSES].sort()).toEqual([
      'CANCELLED',
      'CLINICAL_COMPLETE',
      'CONSENT_REFUSED',
      'CONSENT_REVOKED',
      'NO_SHOW',
    ]);
    for (const status of TERMINAL_SESSION_STATUSES) {
      expect(allowedCommands(status, withConsent)).toEqual([]);
    }
  });
});

describe('assertCommandAllowed', () => {
  it('passes for an allowed command', () => {
    expect(() => assertCommandAllowed('CONSENTED', 'START', withConsent)).not.toThrow();
  });

  it('throws a 409 TREATMENT_SESSION_INVALID_TRANSITION for a disallowed one', () => {
    try {
      assertCommandAllowed('CLINICAL_COMPLETE', 'START', withConsent);
      throw new Error('expected to throw');
    } catch (e) {
      expect((e as { getStatus(): number }).getStatus()).toBe(409);
      expect((e as { getResponse(): unknown }).getResponse()).toMatchObject({
        statusCode: 409,
        code: 'TREATMENT_SESSION_INVALID_TRANSITION',
        status: 'CLINICAL_COMPLETE',
        command: 'START',
      });
    }
  });

  it('rejects START from READY_FOR_CONSENT only when consent is required', () => {
    expect(() => assertCommandAllowed('READY_FOR_CONSENT', 'START', withConsent)).toThrow();
    expect(() => assertCommandAllowed('READY_FOR_CONSENT', 'START', withoutConsent)).not.toThrow();
  });
});

describe('statusAfterIntake', () => {
  const formRequired: TreatmentRequirements = { ...withConsent, medicalForm: { required: true } };

  it('stays in intake while a required form is missing', () => {
    expect(statusAfterIntake(formRequired, { hasForm: false, hasApplicableConsent: false })).toBe(
      'INTAKE_IN_PROGRESS',
    );
    expect(statusAfterIntake(formRequired, { hasForm: false, hasApplicableConsent: true })).toBe(
      'INTAKE_IN_PROGRESS',
    );
  });

  it('is ready for consent once the form is satisfied but no applicable consent exists', () => {
    expect(statusAfterIntake(formRequired, { hasForm: true, hasApplicableConsent: false })).toBe(
      'READY_FOR_CONSENT',
    );
    expect(statusAfterIntake(withConsent, { hasForm: false, hasApplicableConsent: false })).toBe(
      'READY_FOR_CONSENT',
    );
  });

  it('is ready for consent when consent is not required', () => {
    expect(statusAfterIntake(withoutConsent, { hasForm: false, hasApplicableConsent: false })).toBe(
      'READY_FOR_CONSENT',
    );
    expect(statusAfterIntake(withoutConsent, { hasForm: true, hasApplicableConsent: true })).toBe(
      'READY_FOR_CONSENT',
    );
  });

  it('is consented when consent is required and applicable', () => {
    expect(statusAfterIntake(formRequired, { hasForm: true, hasApplicableConsent: true })).toBe(
      'CONSENTED',
    );
    expect(statusAfterIntake(withConsent, { hasForm: false, hasApplicableConsent: true })).toBe(
      'CONSENTED',
    );
  });
});
