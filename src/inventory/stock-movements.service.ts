import { Injectable } from '@nestjs/common';
import { Prisma, StockAdjustmentReason, StockMovementKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_PAGE_SIZE = 20;

export interface ListStockMovementsInput {
  productId?: string;
  branchId?: string;
  kind?: StockMovementKind;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface StockMovementView {
  id: string;
  kind: StockMovementKind;
  product: { id: string; code: string; name: string };
  branch: { id: string; name: string };
  lotId: string;
  lotNumber: string | null;
  quantity: number;
  unitCost: string;
  adjustmentReason: StockAdjustmentReason | null;
  note: string | null;
  receiptId: string | null;
  transferId: string | null;
  orderItemId: string | null;
  createdBy: { id: string; firstName: string; lastName: string };
  createdAt: Date;
}

const movementInclude = {
  product: { select: { id: true, code: true, name: true } },
  branch: { select: { id: true, name: true } },
  lot: { select: { lotNumber: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.StockMovementInclude;

@Injectable()
export class StockMovementsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, query: ListStockMovementsInput) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.StockMovementWhereInput = {
      tenantId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: movementInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    const items: StockMovementView[] = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      product: row.product,
      branch: row.branch,
      lotId: row.lotId,
      lotNumber: row.lot.lotNumber,
      quantity: row.quantity,
      unitCost: row.unitCost.toFixed(2),
      adjustmentReason: row.adjustmentReason,
      note: row.note,
      receiptId: row.receiptId,
      transferId: row.transferId,
      orderItemId: row.orderItemId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }));
    return { items, total, page, pageSize };
  }
}
