import { Prisma } from '@prisma/client';
import { zonedDateString } from '../common/utils/timezone';
import { allocateFefo, FefoLot, isLotExpired } from './fefo';

const TODAY = '2026-10-26';

function lot(
  id: string,
  quantityOnHand: number,
  expiresAt: string | null,
  receivedAt = '2026-09-01',
  unitCost = '1.00',
): FefoLot {
  return {
    id,
    quantityOnHand,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    receivedAt: new Date(receivedAt),
    unitCost: new Prisma.Decimal(unitCost),
  };
}

describe('isLotExpired', () => {
  it('is not expired on its expiry day', () => {
    expect(isLotExpired(new Date('2026-10-26'), TODAY)).toBe(false);
  });

  it('is expired the day after its expiry day', () => {
    expect(isLotExpired(new Date('2026-10-25'), TODAY)).toBe(true);
  });

  it('never expires without an expiry date', () => {
    expect(isLotExpired(null, TODAY)).toBe(false);
  });

  it('sells a lot through its expiry day in Guayaquil and not after it', () => {
    const expiresAt = new Date('2026-10-26');
    const at2330 = new Date('2026-10-27T04:30:00Z');
    const at0001 = new Date('2026-10-27T05:01:00Z');
    expect(isLotExpired(expiresAt, zonedDateString(at2330, 'America/Guayaquil'))).toBe(false);
    expect(zonedDateString(at0001, 'America/Guayaquil')).toBe('2026-10-27');
    expect(isLotExpired(expiresAt, zonedDateString(at0001, 'America/Guayaquil'))).toBe(true);
  });
});

describe('allocateFefo', () => {
  const lots = [
    lot('C', 9, null),
    lot('B', 5, '2027-03-01'),
    lot('D', 4, '2026-10-01'),
    lot('A', 1, '2026-12-01'),
  ];

  it('takes from the soonest-expiring sellable lots first', () => {
    const result = allocateFefo(lots, 2, TODAY);
    expect(result.available).toBe(15);
    expect(result.takes.map((t) => [t.lotId, t.quantity])).toEqual([
      ['A', 1],
      ['B', 1],
    ]);
  });

  it('returns no takes when the sellable stock is not enough', () => {
    expect(allocateFefo(lots, 16, TODAY)).toEqual({ takes: [], available: 15 });
  });

  it('puts lots without expiry last', () => {
    const result = allocateFefo(lots, 15, TODAY);
    expect(result.takes.map((t) => t.lotId)).toEqual(['A', 'B', 'C']);
  });

  it('breaks an expiry tie by the earlier receivedAt', () => {
    const tied = [
      lot('late', 3, '2027-01-01', '2026-09-10'),
      lot('early', 3, '2027-01-01', '2026-09-01'),
    ];
    expect(allocateFefo(tied, 4, TODAY).takes.map((t) => [t.lotId, t.quantity])).toEqual([
      ['early', 3],
      ['late', 1],
    ]);
  });

  it('skips empty lots and carries each lot unit cost into its take', () => {
    const result = allocateFefo(
      [
        lot('empty', 0, '2026-11-01'),
        lot('x', 2, '2026-12-01', '2026-09-01', '1.50'),
        lot('y', 2, null, '2026-09-01', '2.25'),
      ],
      3,
      TODAY,
    );
    expect(result.takes.map((t) => [t.lotId, t.quantity, t.unitCost.toFixed(2)])).toEqual([
      ['x', 2, '1.50'],
      ['y', 1, '2.25'],
    ]);
  });
});
