import {
  canonicalJson,
  encounterContentHash,
  isRecordSigned,
  recordContentHash,
  SignableRecord,
} from './clinical-signature';

const record = (overrides: Partial<SignableRecord> = {}): SignableRecord => ({
  id: 'record-1',
  patientId: 'patient-1',
  professionalId: 'pro-1',
  moduleKey: 'gynecology.consultation',
  schemaVersion: 1,
  formDefinitionId: null,
  appointmentId: null,
  encounterId: 'encounter-1',
  recordDate: new Date('2026-11-08T15:00:00Z'),
  data: { chiefComplaint: 'Control', managementPlan: 'Control anual' },
  notes: null,
  amendsRecordId: null,
  amendmentReason: null,
  ...overrides,
});

describe('clinical signatures', () => {
  it('writes one text per value: keys sorted at every level, dates as ISO strings', () => {
    expect(
      canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: new Date('2026-01-01T00:00:00Z') } }),
    ).toBe('{"a":{"c":"2026-01-01T00:00:00.000Z","d":[{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson({ a: 1, skipped: undefined })).toBe('{"a":1}');
  });

  it('hashes the content of a record the same whatever the order of its fields', () => {
    const hash = recordContentHash(record());

    expect(hash).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(
      recordContentHash(
        record({ data: { managementPlan: 'Control anual', chiefComplaint: 'Control' } }),
      ),
    ).toBe(hash);
  });

  it('gives another hash to any change of content, date, notes or correction', () => {
    const hash = recordContentHash(record());

    for (const changed of [
      record({ data: { chiefComplaint: 'Control', managementPlan: 'Otro plan' } }),
      record({ recordDate: new Date('2026-11-08T15:00:01Z') }),
      record({ notes: 'Nota' }),
      record({ amendsRecordId: 'record-0', amendmentReason: 'Error de digitación' }),
    ]) {
      expect(recordContentHash(changed)).not.toBe(hash);
    }
  });

  it('covers the hashes of what the encounter holds, in any order', () => {
    const encounter = {
      id: 'encounter-1',
      patientId: 'patient-1',
      professionalId: 'pro-1',
      specialtyId: 'gyn',
      appointmentId: null,
      branchId: null,
      encounterType: 'CONTROL',
      reason: 'Control anual',
      summary: null,
      startedAt: new Date('2026-11-08T15:00:00Z'),
      closedAt: new Date('2026-11-08T15:30:00Z'),
    };
    const records = [
      { id: 'b', contentHash: 'v1:b' },
      { id: 'a', contentHash: 'v1:a' },
    ];

    const hash = encounterContentHash(encounter, records, []);

    expect(encounterContentHash(encounter, [...records].reverse(), [])).toBe(hash);
    expect(encounterContentHash(encounter, [records[0]], [])).not.toBe(hash);
    expect(
      encounterContentHash(encounter, records, [{ id: 'note-1', contentHash: 'v1:n' }]),
    ).not.toBe(hash);
  });

  it('treats as final a signed record, one outside any encounter and one of a closed encounter', () => {
    expect(
      isRecordSigned({ signedAt: new Date(), encounterId: 'e', encounter: { status: 'OPEN' } }),
    ).toBe(true);
    expect(isRecordSigned({ signedAt: null, encounterId: null })).toBe(true);
    expect(
      isRecordSigned({ signedAt: null, encounterId: 'e', encounter: { status: 'CLOSED' } }),
    ).toBe(true);
    expect(
      isRecordSigned({ signedAt: null, encounterId: 'e', encounter: { status: 'OPEN' } }),
    ).toBe(false);
  });
});
