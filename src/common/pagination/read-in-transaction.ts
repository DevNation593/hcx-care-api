import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Runs the reads of a page (its total, its rows, a summary) in ONE transaction: the RLS context
 * is applied once and the reads share a snapshot, so the total always describes the rows.
 * The queries run in sequence on `tx`; the outer client must not be used inside `run`.
 */
export function readInTransaction<T>(
  prisma: PrismaService,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await prisma.applyRlsContext(tx);
      return run(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
