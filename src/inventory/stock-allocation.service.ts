import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { allocateFefo, FefoLot } from './fefo';
import { insufficientStock } from './inventory-errors';
import { addToLot, takeFromLot } from './stock-ledger';

interface LockedLotRow {
  id: string;
  quantityOnHand: number;
  expiresAt: Date | null;
  receivedAt: Date;
  unitCost: Prisma.Decimal | string | number;
}

export interface ReserveStockInput {
  tenantId: string;
  actorId: string;
  orderItemId: string;
  productId: string;
  branchId: string;
  quantity: number;
  /** Clinic calendar day (YYYY-MM-DD) used to skip expired lots. */
  today: string;
}

export interface ReleaseStockInput {
  tenantId: string;
  actorId: string;
  orderItemIds: string[];
}

/** Draws order lines from stock lots and gives them back. Runs inside the caller's transaction. */
@Injectable()
export class StockAllocationService {
  async reserve(tx: Prisma.TransactionClient, input: ReserveStockInput): Promise<void> {
    // FOR UPDATE makes registers selling the same product in the branch wait for each other;
    // ordering by id keeps the lock order stable.
    const rows = await tx.$queryRaw<LockedLotRow[]>(
      Prisma.sql`SELECT "id", "quantityOnHand", "expiresAt", "receivedAt", "unitCost" FROM "StockLot" WHERE "tenantId" = ${input.tenantId} AND "productId" = ${input.productId} AND "branchId" = ${input.branchId} AND "quantityOnHand" > 0 ORDER BY "id" FOR UPDATE`,
    );
    const lots: FefoLot[] = rows.map((row) => ({
      id: row.id,
      quantityOnHand: Number(row.quantityOnHand),
      expiresAt: row.expiresAt,
      receivedAt: row.receivedAt,
      unitCost: new Prisma.Decimal(row.unitCost),
    }));

    const { takes, available } = allocateFefo(lots, input.quantity, input.today);
    if (takes.length === 0) throw insufficientStock(available);

    for (const take of takes) {
      const taken = await takeFromLot(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        lotId: take.lotId,
        productId: input.productId,
        branchId: input.branchId,
        kind: 'SALE',
        quantity: -take.quantity,
        unitCost: take.unitCost,
        orderItemId: input.orderItemId,
      });
      // Another transaction won the lot: the caller's transaction rolls back every take.
      if (!taken) throw insufficientStock(0);
      await tx.orderItemLot.create({
        data: {
          tenantId: input.tenantId,
          orderItemId: input.orderItemId,
          lotId: take.lotId,
          quantity: take.quantity,
          unitCost: take.unitCost,
        },
      });
    }
  }

  /** Returns the drawn units to their lots, expired or not. The OrderItemLot rows stay as history. */
  async release(tx: Prisma.TransactionClient, input: ReleaseStockInput): Promise<void> {
    if (input.orderItemIds.length === 0) return;
    const drawn = await tx.orderItemLot.findMany({
      where: { tenantId: input.tenantId, orderItemId: { in: input.orderItemIds } },
      select: {
        orderItemId: true,
        lotId: true,
        quantity: true,
        unitCost: true,
        lot: { select: { productId: true, branchId: true } },
      },
      orderBy: { lotId: 'asc' },
    });
    for (const line of drawn) {
      await addToLot(tx, {
        tenantId: input.tenantId,
        actorId: input.actorId,
        lotId: line.lotId,
        productId: line.lot.productId,
        branchId: line.lot.branchId,
        kind: 'SALE_RELEASE',
        quantity: line.quantity,
        unitCost: line.unitCost,
        orderItemId: line.orderItemId,
      });
    }
  }
}
