import { Prisma } from '@prisma/client';
import { loadSessionBillingFacts, SessionForBilling } from './eligibility-facts';

describe('loadSessionBillingFacts', () => {
  const tx = {
    specialtyRecord: { count: jest.fn() },
    patientFile: { count: jest.fn() },
    treatmentVersion: { findUnique: jest.fn() },
    consentDocument: { findMany: jest.fn() },
  };
  const now = new Date('2026-10-15T12:00:00Z');

  const session = (extra: Record<string, unknown> = {}) =>
    ({
      id: 'session-1',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      status: 'CLINICAL_COMPLETE',
      formRecordId: 'form-1',
      consentDocumentId: null,
      startedAt: null,
      completedAt: null,
      procedureNotes: null,
      treatmentVersionId: 'version-1',
      patient: { firstName: 'Ana', lastName: 'Paz' },
      treatmentVersion: {
        id: 'version-1',
        consentTemplateVersionId: 'consent-v1',
        price: new Prisma.Decimal('100'),
        requirements: {
          medicalForm: { required: true },
          informedConsent: { required: true, validityDays: null },
        },
      },
      ...extra,
    }) as unknown as SessionForBilling;

  const load = (s: SessionForBilling) =>
    loadSessionBillingFacts(tx as unknown as Prisma.TransactionClient, s, 'item-1', now);

  beforeEach(() => {
    jest.resetAllMocks();
    tx.specialtyRecord.count.mockResolvedValue(1);
    tx.patientFile.count.mockResolvedValue(0);
    tx.treatmentVersion.findUnique.mockResolvedValue({ treatmentId: 'treatment-1' });
    tx.consentDocument.findMany.mockResolvedValue([]);
  });

  it('keeps the consent pinned at start even if its document was revoked later', async () => {
    const facts = await load(
      session({ startedAt: new Date('2026-10-14T10:00:00Z'), consentDocumentId: 'doc-1' }),
    );
    expect(facts.hasApplicableConsent).toBe(true);
    expect(facts.patientName).toBe('Ana Paz');
    expect(facts.itemId).toBe('item-1');
  });

  it('has no applicable consent for a session not started without a signed document', async () => {
    const facts = await load(session());
    expect(facts.hasApplicableConsent).toBe(false);
    expect(facts.hasForm).toBe(true);
  });

  it('reads completion from completedAt', async () => {
    expect((await load(session())).completed).toBe(false);
    const done = await load(session({ completedAt: new Date('2026-10-14T11:00:00Z') }));
    expect(done.completed).toBe(true);
  });
});
