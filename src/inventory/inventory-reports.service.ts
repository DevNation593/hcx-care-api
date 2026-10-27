import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { zonedDateString } from '../common/utils/timezone';
import { PrismaService } from '../prisma/prisma.service';
import { clinicToday } from './clinic-today';
import { isLotExpired } from './fefo';
import { reportRangeTooLong } from './inventory-errors';

const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpiringLot {
  lotId: string;
  product: { id: string; code: string; name: string };
  branch: { id: string; name: string };
  lotNumber: string | null;
  expiresAt: Date;
  quantityOnHand: number;
  value: string;
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const addDays = (day: string, days: number) =>
  new Date(dayMs(day) + days * DAY_MS).toISOString().slice(0, 10);
const zero = () => new Prisma.Decimal(0);

@Injectable()
export class InventoryReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Σ quantityOnHand × unitCost per branch and product, expired lots included. */
  async valuation(tenantId: string, query: { branchId?: string }) {
    const lots = await this.prisma.stockLot.findMany({
      where: {
        tenantId,
        quantityOnHand: { gt: 0 },
        ...(query.branchId ? { branchId: query.branchId } : {}),
      },
      select: {
        branchId: true,
        productId: true,
        quantityOnHand: true,
        unitCost: true,
        branch: { select: { name: true } },
        product: { select: { code: true, name: true } },
      },
    });

    interface ProductRow {
      productId: string;
      code: string;
      name: string;
      units: number;
      value: Prisma.Decimal;
    }
    interface BranchRow {
      branchId: string;
      branchName: string;
      units: number;
      value: Prisma.Decimal;
      products: Map<string, ProductRow>;
    }
    const branches = new Map<string, BranchRow>();
    for (const lot of lots) {
      const value = lot.unitCost.times(lot.quantityOnHand);
      const branch = branches.get(lot.branchId) ?? {
        branchId: lot.branchId,
        branchName: lot.branch.name,
        units: 0,
        value: zero(),
        products: new Map<string, ProductRow>(),
      };
      branches.set(lot.branchId, branch);
      branch.units += lot.quantityOnHand;
      branch.value = branch.value.plus(value);
      const product = branch.products.get(lot.productId) ?? {
        productId: lot.productId,
        code: lot.product.code,
        name: lot.product.name,
        units: 0,
        value: zero(),
      };
      product.units += lot.quantityOnHand;
      product.value = product.value.plus(value);
      branch.products.set(lot.productId, product);
    }

    let total = zero();
    const result = [...branches.values()]
      .sort((a, b) => a.branchName.localeCompare(b.branchName))
      .map((branch) => {
        total = total.plus(branch.value);
        return {
          branchId: branch.branchId,
          branchName: branch.branchName,
          units: branch.units,
          value: branch.value.toFixed(2),
          products: [...branch.products.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((product) => ({ ...product, value: product.value.toFixed(2) })),
        };
      });
    return { branches: result, totalValue: total.toFixed(2) };
  }

  /** Lots with balance already expired, and those expiring today or within `days`. */
  async expiring(tenantId: string, query: { days?: number; branchId?: string }) {
    const days = query.days ?? 30;
    const today = await clinicToday(this.prisma, tenantId);
    const limit = addDays(today, days);
    const lots = await this.prisma.stockLot.findMany({
      where: {
        tenantId,
        quantityOnHand: { gt: 0 },
        expiresAt: { not: null, lte: new Date(`${limit}T00:00:00.000Z`) },
        ...(query.branchId ? { branchId: query.branchId } : {}),
      },
      select: {
        id: true,
        lotNumber: true,
        expiresAt: true,
        quantityOnHand: true,
        unitCost: true,
        product: { select: { id: true, code: true, name: true } },
        branch: { select: { id: true, name: true } },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    });

    const expired: ExpiringLot[] = [];
    const expiring: ExpiringLot[] = [];
    for (const lot of lots) {
      if (!lot.expiresAt) continue;
      const view: ExpiringLot = {
        lotId: lot.id,
        product: lot.product,
        branch: lot.branch,
        lotNumber: lot.lotNumber,
        expiresAt: lot.expiresAt,
        quantityOnHand: lot.quantityOnHand,
        value: lot.unitCost.times(lot.quantityOnHand).toFixed(2),
      };
      (isLotExpired(lot.expiresAt, today) ? expired : expiring).push(view);
    }
    return { expired, expiring };
  }

  /** Active products with a minimum whose non-expired balance in a branch is below it. */
  async lowStock(tenantId: string, query: { branchId?: string }) {
    const today = await clinicToday(this.prisma, tenantId);
    const [products, branches] = await Promise.all([
      this.prisma.product.findMany({
        where: { tenantId, isActive: true, minStock: { gt: 0 } },
        select: { id: true, code: true, name: true, minStock: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.branch.findMany({
        where: { tenantId, isActive: true, ...(query.branchId ? { id: query.branchId } : {}) },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    if (products.length === 0 || branches.length === 0) return [];

    const lots = await this.prisma.stockLot.findMany({
      where: {
        tenantId,
        productId: { in: products.map((product) => product.id) },
        branchId: { in: branches.map((branch) => branch.id) },
        quantityOnHand: { gt: 0 },
      },
      select: { productId: true, branchId: true, quantityOnHand: true, expiresAt: true },
    });
    const available = new Map<string, number>();
    for (const lot of lots) {
      if (isLotExpired(lot.expiresAt, today)) continue;
      const key = `${lot.productId}:${lot.branchId}`;
      available.set(key, (available.get(key) ?? 0) + lot.quantityOnHand);
    }

    return products.flatMap((product) =>
      branches.flatMap((branch) => {
        const units = available.get(`${product.id}:${branch.id}`) ?? 0;
        if (units >= product.minStock) return [];
        return [
          {
            productId: product.id,
            code: product.code,
            name: product.name,
            branchId: branch.id,
            branchName: branch.name,
            available: units,
            minStock: product.minStock,
          },
        ];
      }),
    );
  }

  /**
   * Net sales minus lot cost of PRODUCT lines in PAID or INVOICED orders. `from` and `to` are
   * clinic calendar days, both inclusive, matched against the order's creation day.
   */
  async margin(tenantId: string, query: { from: string; to: string; branchId?: string }) {
    const span = (dayMs(query.to) - dayMs(query.from)) / DAY_MS + 1;
    if (span > MAX_RANGE_DAYS) throw reportRangeTooLong();

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { timezone: true },
    });
    // Fetch a day of slack on both sides, then keep the orders whose clinic day is in range.
    const items = await this.prisma.orderItem.findMany({
      where: {
        tenantId,
        kind: 'PRODUCT',
        releasedAt: null,
        productId: { not: null },
        order: {
          status: { in: ['PAID', 'INVOICED'] },
          createdAt: {
            gte: new Date(dayMs(query.from) - DAY_MS),
            lt: new Date(dayMs(query.to) + 2 * DAY_MS),
          },
          ...(query.branchId ? { branchId: query.branchId } : {}),
        },
      },
      select: {
        productId: true,
        quantity: true,
        lineSubtotal: true,
        order: { select: { createdAt: true } },
        product: { select: { code: true, name: true } },
        lots: { select: { quantity: true, unitCost: true } },
      },
    });

    interface Row {
      productId: string;
      code: string;
      name: string;
      units: Prisma.Decimal;
      revenue: Prisma.Decimal;
      cost: Prisma.Decimal;
    }
    const rows = new Map<string, Row>();
    let revenue = zero();
    let cost = zero();
    for (const item of items) {
      const day = zonedDateString(item.order.createdAt, settings?.timezone);
      if (day < query.from || day > query.to || !item.productId || !item.product) continue;
      const itemCost = item.lots.reduce(
        (sum, lot) => sum.plus(lot.unitCost.times(lot.quantity)),
        zero(),
      );
      const row = rows.get(item.productId) ?? {
        productId: item.productId,
        code: item.product.code,
        name: item.product.name,
        units: zero(),
        revenue: zero(),
        cost: zero(),
      };
      row.units = row.units.plus(item.quantity);
      row.revenue = row.revenue.plus(item.lineSubtotal);
      row.cost = row.cost.plus(itemCost);
      rows.set(item.productId, row);
      revenue = revenue.plus(item.lineSubtotal);
      cost = cost.plus(itemCost);
    }

    return {
      revenue: revenue.toFixed(2),
      cost: cost.toFixed(2),
      margin: revenue.minus(cost).toFixed(2),
      products: [...rows.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((row) => ({
          productId: row.productId,
          code: row.code,
          name: row.name,
          units: row.units.toNumber(),
          revenue: row.revenue.toFixed(2),
          cost: row.cost.toFixed(2),
          margin: row.revenue.minus(row.cost).toFixed(2),
        })),
    };
  }
}
