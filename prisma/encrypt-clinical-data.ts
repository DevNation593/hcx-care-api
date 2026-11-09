import { Prisma, PrismaClient } from '@prisma/client';
import { ClinicalCipher, parseClinicalKeys } from '../src/clinical-access/clinical-cipher';

/**
 * Encrypts clinical data that is still in plain text and re-encrypts values written with a
 * retired key. Safe to run again: rows already under the active key are left untouched.
 *
 *   npm run prisma:encrypt-clinical-data -- --dry-run   # count only
 *   npm run prisma:encrypt-clinical-data                # write
 */

const NOTE_FIELDS = [
  'content',
  'diagnosis',
  'treatment',
  'observations',
  'deletionReason',
] as const;
const BATCH_SIZE = 200;

export type EncryptionReport = Record<
  | 'clinicalNotes'
  | 'specialtyRecords'
  | 'encounters'
  | 'patientFiles'
  | 'clinicalOrders'
  | 'clinicalResults'
  | 'clinicalFollowUps'
  | 'auditLogs',
  { scanned: number; updated: number }
>;

type Row = { id: string; tenantId: string } & Record<string, unknown>;
type Delegate = {
  findMany(args: object): Promise<Row[]>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
};
type EncryptionClient = Record<
  | 'clinicalNote'
  | 'specialtyRecord'
  | 'encounter'
  | 'patientFile'
  | 'clinicalOrder'
  | 'clinicalResult'
  | 'clinicalFollowUp'
  | 'auditLog',
  Delegate
>;

const reencryptText = (cipher: ClinicalCipher, tenantId: string, value: string) =>
  cipher.encrypt(tenantId, cipher.decrypt(tenantId, value));

const reencryptJson = (cipher: ClinicalCipher, tenantId: string, value: unknown) =>
  cipher.encryptJson(tenantId, cipher.decryptJson(tenantId, value)) as Prisma.InputJsonValue;

/** The columns of a row that must be rewritten, or null when the row is already protected. */
function pendingChanges(
  cipher: ClinicalCipher,
  row: Row,
  textFields: readonly string[],
  jsonFields: readonly string[],
): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};
  for (const field of textFields) {
    const value = row[field];
    if (typeof value === 'string' && cipher.needsReencryption(value)) {
      data[field] = reencryptText(cipher, row.tenantId, value);
    }
  }
  for (const field of jsonFields) {
    if (cipher.needsReencryption(row[field])) {
      data[field] = reencryptJson(cipher, row.tenantId, row[field]);
    }
  }
  return Object.keys(data).length > 0 ? data : null;
}

async function processTable(
  delegate: Delegate,
  where: object,
  cipher: ClinicalCipher,
  textFields: readonly string[],
  jsonFields: readonly string[],
  dryRun: boolean,
) {
  const report = { scanned: 0, updated: 0 };
  let cursor: string | undefined;

  for (;;) {
    const rows = await delegate.findMany({
      where,
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) return report;

    for (const row of rows) {
      report.scanned += 1;
      const data = pendingChanges(cipher, row, textFields, jsonFields);
      if (!data) continue;
      report.updated += 1;
      if (!dryRun) await delegate.update({ where: { id: row.id }, data });
    }
    cursor = rows[rows.length - 1].id;
  }
}

export async function encryptClinicalData(
  client: EncryptionClient,
  cipher: ClinicalCipher,
  options: { dryRun?: boolean } = {},
): Promise<EncryptionReport> {
  if (!cipher.enabled) {
    throw new Error('CLINICAL_ENCRYPTION_KEYS must be set to encrypt clinical data');
  }
  const dryRun = options.dryRun ?? false;

  return {
    // Removed notes are included: they stay in the database for audit.
    clinicalNotes: await processTable(client.clinicalNote, {}, cipher, NOTE_FIELDS, [], dryRun),
    specialtyRecords: await processTable(
      client.specialtyRecord,
      {},
      cipher,
      ['notes', 'deletionReason', 'amendmentReason'],
      ['data'],
      dryRun,
    ),
    encounters: await processTable(
      client.encounter,
      {},
      cipher,
      ['reason', 'summary', 'deletionReason'],
      [],
      dryRun,
    ),
    // Names and descriptions only: the stored bytes keep the key they were written with,
    // which is why a retired key must stay in CLINICAL_ENCRYPTION_KEYS while files use it.
    patientFiles: await processTable(
      client.patientFile,
      {},
      cipher,
      ['fileName', 'description', 'deletionReason'],
      [],
      dryRun,
    ),
    clinicalOrders: await processTable(
      client.clinicalOrder,
      {},
      cipher,
      [
        'studyName',
        'indication',
        'provider',
        'externalReference',
        'sampleNotes',
        'completionNote',
        'cancellationReason',
      ],
      [],
      dryRun,
    ),
    clinicalResults: await processTable(
      client.clinicalResult,
      {},
      cipher,
      ['issuedBy', 'content', 'reviewNote', 'communicationNote'],
      [],
      dryRun,
    ),
    clinicalFollowUps: await processTable(
      client.clinicalFollowUp,
      {},
      cipher,
      ['title', 'description', 'closureNote'],
      [],
      dryRun,
    ),
    auditLogs: await processTable(
      client.auditLog,
      {
        entity: {
          in: [
            'CLINICAL_NOTE',
            'SPECIALTY_RECORD',
            'ENCOUNTER',
            'PATIENT_FILE',
            'CLINICAL_ORDER',
            'CLINICAL_RESULT',
            'CLINICAL_FOLLOW_UP',
          ],
        },
      },
      cipher,
      ['reason'],
      ['changes'],
      dryRun,
    ),
  };
}

if (require.main === module) {
  const client = new PrismaClient();
  const dryRun = process.argv.includes('--dry-run');
  Promise.resolve()
    .then(() =>
      encryptClinicalData(
        client as unknown as EncryptionClient,
        new ClinicalCipher(parseClinicalKeys(process.env.CLINICAL_ENCRYPTION_KEYS)),
        { dryRun },
      ),
    )
    .then((report) => console.log(JSON.stringify({ dryRun, ...report }, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => client.$disconnect());
}
