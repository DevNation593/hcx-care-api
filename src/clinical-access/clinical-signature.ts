import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';

/**
 * Clinical signatures. A signed record or encounter keeps the SHA-256 of its content at the
 * moment it was signed, computed over the decrypted values so that rotating the encryption key
 * never changes it. The hash is prefixed with the version of this algorithm.
 */
export const SIGNATURE_ALGORITHM = 'v1';

/** JSON with object keys sorted at every level and dates as ISO strings: one text per value. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function sha256(payload: unknown): string {
  const digest = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  return `${SIGNATURE_ALGORITHM}:${digest}`;
}

/** The decrypted content of a record that its signature covers. */
export interface SignableRecord {
  id: string;
  patientId: string;
  professionalId: string;
  moduleKey: string;
  schemaVersion: number;
  formDefinitionId: string | null;
  appointmentId: string | null;
  encounterId: string | null;
  recordDate: Date;
  data: unknown;
  notes: string | null;
  amendsRecordId: string | null;
  amendmentReason: string | null;
}

export function recordContentHash(record: SignableRecord): string {
  return sha256({
    id: record.id,
    patientId: record.patientId,
    professionalId: record.professionalId,
    moduleKey: record.moduleKey,
    schemaVersion: record.schemaVersion,
    formDefinitionId: record.formDefinitionId,
    appointmentId: record.appointmentId,
    encounterId: record.encounterId,
    recordDate: record.recordDate,
    data: record.data ?? null,
    notes: record.notes,
    amendsRecordId: record.amendsRecordId,
    amendmentReason: record.amendmentReason,
  });
}

/** The decrypted content of a clinical note that its encounter's signature covers. */
export interface SignableNote {
  id: string;
  content: string;
  diagnosis: string | null;
  treatment: string | null;
  observations: string | null;
  sessionDate: Date;
}

export function noteContentHash(note: SignableNote): string {
  return sha256({
    id: note.id,
    content: note.content,
    diagnosis: note.diagnosis,
    treatment: note.treatment,
    observations: note.observations,
    sessionDate: note.sessionDate,
  });
}

/** The decrypted encounter, with the hashes of everything written in it. */
export function encounterContentHash(
  encounter: {
    id: string;
    patientId: string;
    professionalId: string;
    specialtyId: string;
    appointmentId: string | null;
    branchId: string | null;
    encounterType: string;
    reason: string;
    summary: string | null;
    startedAt: Date;
    closedAt: Date;
  },
  records: { id: string; contentHash: string }[],
  notes: { id: string; contentHash: string }[],
): string {
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  return sha256({
    encounter: {
      id: encounter.id,
      patientId: encounter.patientId,
      professionalId: encounter.professionalId,
      specialtyId: encounter.specialtyId,
      appointmentId: encounter.appointmentId,
      branchId: encounter.branchId,
      encounterType: encounter.encounterType,
      reason: encounter.reason,
      summary: encounter.summary,
      startedAt: encounter.startedAt,
      closedAt: encounter.closedAt,
    },
    records: [...records].sort(byId),
    notes: [...notes].sort(byId),
  });
}

/**
 * Whether a record is final: signed, outside any encounter (signed when saved, or older than
 * signatures), or in an encounter that is closed (signed, or closed before signatures existed).
 */
export function isRecordSigned(record: {
  signedAt: Date | null;
  encounterId: string | null;
  encounter?: { status: string } | null;
}): boolean {
  if (record.signedAt) return true;
  if (!record.encounterId) return true;
  return record.encounter?.status === 'CLOSED';
}

export const clinicalRecordSigned = () =>
  new ConflictException({
    statusCode: 409,
    code: 'CLINICAL_RECORD_SIGNED',
    message: 'El registro está firmado: no se modifica ni se elimina. Corrígelo con una adenda.',
  });

export const clinicalRecordVersionConflict = (currentVersion: number) =>
  new ConflictException({
    statusCode: 409,
    code: 'CLINICAL_RECORD_VERSION_CONFLICT',
    message: 'Alguien más modificó este registro. Vuelve a cargarlo antes de guardar.',
    currentVersion,
  });
