import { randomBytes } from 'crypto';
import { encryptClinicalData } from '../prisma/encrypt-clinical-data';
import { ClinicalCipher, parseClinicalKeys } from '../src/clinical-access/clinical-cipher';

type Row = { id: string; tenantId: string } & Record<string, unknown>;

/** In-memory tables with the cursor pagination the script relies on. */
function fakeTable(rows: Row[]) {
  return {
    rows,
    updates: 0,
    async findMany({ take, cursor }: { take: number; cursor?: { id: string } }) {
      const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
      const start = cursor ? sorted.findIndex((row) => row.id === cursor.id) + 1 : 0;
      return sorted.slice(start, start + take).map((row) => ({ ...row }));
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      this.updates += 1;
      Object.assign(rows.find((row) => row.id === where.id)!, data);
    },
  };
}

describe('encrypt-clinical-data script', () => {
  const key = (id: string) => `${id}:${randomBytes(32).toString('base64')}`;
  const oldKey = key('old');
  const oldCipher = new ClinicalCipher(parseClinicalKeys(oldKey));
  const cipher = new ClinicalCipher(parseClinicalKeys(`${key('new')},${oldKey}`));

  const database = () => ({
    clinicalNote: fakeTable([
      {
        id: 'n1',
        tenantId: 't1',
        content: 'Nota en texto plano',
        diagnosis: 'F41.1',
        treatment: null,
        observations: null,
        deletionReason: null,
      },
      {
        id: 'n2',
        tenantId: 't2',
        content: oldCipher.encrypt('t2', 'Nota con clave retirada'),
        diagnosis: null,
        treatment: null,
        observations: null,
        deletionReason: 'Paciente equivocado',
      },
      {
        id: 'n3',
        tenantId: 't1',
        content: cipher.encrypt('t1', 'Nota ya protegida'),
        diagnosis: null,
        treatment: null,
        observations: null,
        deletionReason: null,
      },
    ]),
    specialtyRecord: fakeTable([
      { id: 'r1', tenantId: 't1', data: { bmi: 24 }, notes: 'Revisar', deletionReason: null },
    ]),
    encounter: fakeTable([
      {
        id: 'e1',
        tenantId: 't1',
        reason: 'Motivo de consulta sin cifrar',
        summary: null,
        deletionReason: null,
      },
    ]),
    patientFile: fakeTable([
      {
        id: 'f1',
        tenantId: 't1',
        fileName: 'hemograma sin cifrar.pdf',
        description: null,
        deletionReason: null,
      },
    ]),
    consentDocument: fakeTable([
      { id: 'cd1', tenantId: 't1', title: 'Consentimiento', body: 'Texto', procedureName: 'DIU' },
    ]),
    consentSignature: fakeTable([
      {
        id: 'cs1',
        tenantId: 't1',
        signerName: cipher.encrypt('t1', 'Ana'),
        signerIdentification: cipher.encrypt('t1', ''),
        relationship: null,
        witnessName: null,
      },
    ]),
    user: fakeTable([
      {
        id: 'u1',
        tenantId: 't1',
        mfaSecret: oldCipher.encrypt('t1', 'JBSWY3DPEHPK3PXP'),
        mfaPendingSecret: null,
      },
    ]),
    auditLog: fakeTable([
      {
        id: 'a1',
        tenantId: 't1',
        entity: 'CLINICAL_NOTE',
        changes: { before: null, after: { content: 'Nota en texto plano' } },
        reason: null,
      },
      { id: 'a2', tenantId: 't1', entity: 'CLINICAL_NOTE', changes: null, reason: null },
    ]),
  });

  it('encrypts plain text, rotates retired keys and leaves protected rows alone', async () => {
    const db = database();

    const report = await encryptClinicalData(db, cipher);

    expect(report).toEqual({
      clinicalNotes: { scanned: 3, updated: 2 },
      specialtyRecords: { scanned: 1, updated: 1 },
      encounters: { scanned: 1, updated: 1 },
      patientFiles: { scanned: 1, updated: 1 },
      consentDocuments: { scanned: 1, updated: 1 },
      consentSignatures: { scanned: 1, updated: 0 },
      mfaSecrets: { scanned: 1, updated: 1 },
      auditLogs: { scanned: 2, updated: 1 },
    });
    const stored = JSON.stringify([
      db.clinicalNote.rows,
      db.specialtyRecord.rows,
      db.encounter.rows,
      db.patientFile.rows,
      db.auditLog.rows,
    ]);
    expect(stored).not.toMatch(
      /texto plano|F41|retirada|equivocado|bmi|Revisar|sin cifrar|enc:v1:old:/,
    );

    const [n1, n2] = db.clinicalNote.rows;
    expect(cipher.decrypt('t1', n1.content as string)).toBe('Nota en texto plano');
    expect(cipher.decrypt('t1', n1.diagnosis as string)).toBe('F41.1');
    expect(n1.treatment).toBeNull();
    expect(cipher.decrypt('t2', n2.content as string)).toBe('Nota con clave retirada');
    expect(cipher.decrypt('t2', n2.deletionReason as string)).toBe('Paciente equivocado');
    expect(cipher.decryptJson('t1', db.specialtyRecord.rows[0].data)).toEqual({ bmi: 24 });
    expect(cipher.decryptJson('t1', db.auditLog.rows[0].changes)).toEqual({
      before: null,
      after: { content: 'Nota en texto plano' },
    });
    expect(db.auditLog.rows[1].changes).toBeNull();
    expect(cipher.decrypt('t1', db.user.rows[0].mfaSecret as string)).toBe('JBSWY3DPEHPK3PXP');
    expect(db.user.rows[0].mfaSecret).not.toMatch(/enc:v1:old:/);
  });

  it('changes nothing on a second run', async () => {
    const db = database();
    await encryptClinicalData(db, cipher);
    const firstRun = JSON.stringify(db.clinicalNote.rows);

    const report = await encryptClinicalData(db, cipher);

    expect(Object.values(report).map(({ updated }) => updated)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(JSON.stringify(db.clinicalNote.rows)).toBe(firstRun);
  });

  it('only counts in a dry run', async () => {
    const db = database();

    const report = await encryptClinicalData(db, cipher, { dryRun: true });

    expect(report.clinicalNotes).toEqual({ scanned: 3, updated: 2 });
    expect(db.clinicalNote.updates + db.specialtyRecord.updates + db.auditLog.updates).toBe(0);
    expect(db.clinicalNote.rows[0].content).toBe('Nota en texto plano');
  });

  it('refuses to run without a key', async () => {
    await expect(encryptClinicalData(database(), new ClinicalCipher())).rejects.toThrow(
      /CLINICAL_ENCRYPTION_KEYS/,
    );
  });
});
