import { Prisma } from '@prisma/client';

export interface FefoLot {
  id: string;
  quantityOnHand: number;
  expiresAt: Date | null;
  receivedAt: Date;
  unitCost: Prisma.Decimal;
}

export interface FefoTake {
  lotId: string;
  quantity: number;
  unitCost: Prisma.Decimal;
}

/** `@db.Date` values arrive at UTC midnight, so the ISO date prefix is the calendar day. */
export function isLotExpired(expiresAt: Date | null, today: string): boolean {
  return expiresAt !== null && expiresAt.toISOString().slice(0, 10) < today;
}

/**
 * First-expired-first-out: takes from the soonest-expiring sellable lots (no expiry
 * last, ties by receipt). Returns no takes when the sellable stock is not enough.
 */
export function allocateFefo(
  lots: FefoLot[],
  quantity: number,
  today: string,
): { takes: FefoTake[]; available: number } {
  const sellable = lots
    .filter((lot) => lot.quantityOnHand > 0 && !isLotExpired(lot.expiresAt, today))
    .sort((a, b) => {
      if (a.expiresAt && b.expiresAt) {
        const byExpiry = a.expiresAt.getTime() - b.expiresAt.getTime();
        if (byExpiry !== 0) return byExpiry;
      } else if (a.expiresAt || b.expiresAt) {
        return a.expiresAt ? -1 : 1;
      }
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });

  const available = sellable.reduce((sum, lot) => sum + lot.quantityOnHand, 0);
  if (available < quantity) return { takes: [], available };

  const takes: FefoTake[] = [];
  let remaining = quantity;
  for (const lot of sellable) {
    if (remaining <= 0) break;
    const taken = Math.min(remaining, lot.quantityOnHand);
    takes.push({ lotId: lot.id, quantity: taken, unitCost: lot.unitCost });
    remaining -= taken;
  }
  return { takes, available };
}
