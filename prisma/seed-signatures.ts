import { PrismaClient } from '@prisma/client';
import {
  encounterContentHash,
  noteContentHash,
  recordContentHash,
} from '../src/clinical-access/clinical-signature';

/**
 * Signs what the demo seed wrote the way the API would have: every closed encounter at its close,
 * by its professional, with the records and notes it holds; every record outside an encounter as
 * it was saved. It runs before the clinical content is encrypted, so it reads it in plain text,
 * which is what the hashes cover.
 */
export async function signSeededClinicalContent(db: PrismaClient): Promise<void> {
  const closed = (await db.encounter.findMany({ where: { status: 'CLOSED' } })).filter(
    (encounter) => !encounter.signedAt && !encounter.deletedAt,
  );
  for (const encounter of closed) {
    const signedAt = encounter.closedAt ?? encounter.updatedAt;
    const records = (await db.specialtyRecord.findMany({ where: { encounterId: encounter.id } }))
      .filter((record) => !record.deletedAt)
      .map((record) => ({
        ...record,
        contentHash: record.contentHash ?? recordContentHash(record),
      }));
    for (const record of records.filter((candidate) => !candidate.signedAt)) {
      await db.specialtyRecord.update({
        where: { id: record.id },
        data: { signedAt, contentHash: record.contentHash, updatedAt: record.updatedAt },
      });
    }
    const notes = (await db.clinicalNote.findMany({ where: { encounterId: encounter.id } }))
      .filter((note) => !note.deletedAt)
      .map((note) => ({ id: note.id, contentHash: noteContentHash(note) }));

    await db.encounter.update({
      where: { id: encounter.id },
      data: {
        signedAt,
        signedById: encounter.professionalId,
        contentHash: encounterContentHash(
          { ...encounter, closedAt: signedAt },
          records.map(({ id, contentHash }) => ({ id, contentHash })),
          notes,
        ),
        updatedAt: encounter.updatedAt,
      },
    });
  }

  const standalone = (await db.specialtyRecord.findMany({ where: {} })).filter(
    (record) => !record.encounterId && !record.signedAt,
  );
  for (const record of standalone) {
    await db.specialtyRecord.update({
      where: { id: record.id },
      data: {
        signedAt: record.createdAt,
        contentHash: recordContentHash(record),
        updatedAt: record.updatedAt,
      },
    });
  }
}
