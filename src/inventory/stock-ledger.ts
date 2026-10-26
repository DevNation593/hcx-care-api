import { Prisma, StockAdjustmentReason, StockMovementKind } from '@prisma/client';
import { lotNotFound } from './inventory-errors';

// The only code that changes a lot's balance: every change writes its StockMovement.

export interface MovementInput {
  tenantId: string;
  actorId: string;
  lotId: string;
  productId: string;
  branchId: string;
  kind: StockMovementKind;
  /** Signed units: negative takes from the lot, positive adds to it. */
  quantity: number;
  unitCost: Prisma.Decimal;
  adjustmentReason?: StockAdjustmentReason;
  note?: string;
  receiptId?: string;
  transferId?: string;
  orderItemId?: string;
}

async function writeMovement(tx: Prisma.TransactionClient, input: MovementInput): Promise<void> {
  await tx.stockMovement.create({
    data: {
      tenantId: input.tenantId,
      kind: input.kind,
      productId: input.productId,
      branchId: input.branchId,
      lotId: input.lotId,
      quantity: input.quantity,
      unitCost: input.unitCost,
      adjustmentReason: input.adjustmentReason ?? null,
      note: input.note ?? null,
      receiptId: input.receiptId ?? null,
      transferId: input.transferId ?? null,
      orderItemId: input.orderItemId ?? null,
      createdById: input.actorId,
    },
  });
}

/**
 * Takes `-input.quantity` units only while the lot still holds them; returns false (and
 * writes nothing) when another transaction left it short.
 */
export async function takeFromLot(
  tx: Prisma.TransactionClient,
  input: MovementInput,
): Promise<boolean> {
  const units = -input.quantity;
  const { count } = await tx.stockLot.updateMany({
    where: { id: input.lotId, tenantId: input.tenantId, quantityOnHand: { gte: units } },
    data: { quantityOnHand: { decrement: units } },
  });
  if (count === 0) return false;
  await writeMovement(tx, input);
  return true;
}

export async function addToLot(tx: Prisma.TransactionClient, input: MovementInput): Promise<void> {
  const { count } = await tx.stockLot.updateMany({
    where: { id: input.lotId, tenantId: input.tenantId },
    data: { quantityOnHand: { increment: input.quantity } },
  });
  if (count === 0) throw lotNotFound();
  await writeMovement(tx, input);
}

/** For a lot just created with its balance: records the movement that brought it. */
export async function recordInitialMovement(
  tx: Prisma.TransactionClient,
  input: MovementInput,
): Promise<void> {
  await writeMovement(tx, input);
}
