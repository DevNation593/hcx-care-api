import { PrismaClient } from '@prisma/client';
import {
  encounterContentHash,
  fileContentHash,
  noteContentHash,
  orderContentHash,
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
    // The seed keeps the hash of the bytes of every file it writes, as the API does on upload.
    const files = (await db.patientFile.findMany({ where: { encounterId: encounter.id } }))
      .filter((file) => !file.deletedAt && file.contentHash)
      .map((file) => ({
        id: file.id,
        contentHash: fileContentHash({ ...file, contentHash: file.contentHash! }),
      }));

    const orders = await db.clinicalOrder.findMany({ where: { encounterId: encounter.id } });
    const orderHashes = orders.map((order) => ({
      id: order.id,
      contentHash: order.contentHash ?? orderContentHash(order),
    }));
    for (const { id, contentHash } of orderHashes) {
      const order = orders.find((candidate) => candidate.id === id)!;
      if (order.signedAt) continue;
      await db.clinicalOrder.update({
        where: { id },
        data: { signedAt, contentHash, updatedAt: order.updatedAt },
      });
    }

    await db.encounter.update({
      where: { id: encounter.id },
      data: {
        signedAt,
        signedById: encounter.professionalId,
        contentHash: encounterContentHash(
          { ...encounter, closedAt: signedAt },
          records.map(({ id, contentHash }) => ({ id, contentHash })),
          notes,
          files,
          orderHashes,
        ),
        updatedAt: encounter.updatedAt,
      },
    });
  }

  // Orders placed outside any encounter are signed when they are saved.
  for (const order of await db.clinicalOrder.findMany({
    where: { encounterId: null, signedAt: null },
  })) {
    await db.clinicalOrder.update({
      where: { id: order.id },
      data: {
        signedAt: order.orderedAt,
        contentHash: orderContentHash(order),
        updatedAt: order.updatedAt,
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
