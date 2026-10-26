import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assertBranchAvailable } from '../branches/branches.service';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { clinicToday } from './clinic-today';
import { CreateStockReceiptDto, ListStockReceiptsQuery } from './dto/stock-receipt.dto';
import {
  lotAlreadyExpired,
  lotExpiryRequired,
  productInactive,
  productNotFound,
  stockReceiptNotFound,
} from './inventory-errors';
import { recordInitialMovement } from './stock-ledger';

const DEFAULT_PAGE_SIZE = 20;

export interface StockReceiptLineView {
  lotId: string;
  product: { id: string; code: string; name: string };
  quantity: number;
  unitCost: string;
  lotNumber: string | null;
  expiresAt: Date | null;
}

export interface StockReceiptView {
  id: string;
  branch: { id: string; name: string };
  supplierName: string | null;
  documentNumber: string | null;
  receivedAt: Date;
  note: string | null;
  createdBy: { id: string; firstName: string; lastName: string };
  lines: StockReceiptLineView[];
}

const receiptInclude = {
  branch: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  lots: {
    orderBy: { id: 'asc' as const },
    include: { product: { select: { id: true, code: true, name: true } } },
  },
} satisfies Prisma.StockReceiptInclude;

type ReceiptRow = Prisma.StockReceiptGetPayload<{ include: typeof receiptInclude }>;

@Injectable()
export class StockReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tenantId: string,
    userId: string,
    dto: CreateStockReceiptDto,
  ): Promise<StockReceiptView> {
    return runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      await assertBranchAvailable(tx, tenantId, dto.branchId);

      const productIds = [...new Set(dto.lines.map((line) => line.productId))];
      const products = new Map(
        (await tx.product.findMany({ where: { tenantId, id: { in: productIds } } })).map(
          (product) => [product.id, product],
        ),
      );
      const today = await clinicToday(tx, tenantId);

      // Validate every line before writing anything.
      for (const line of dto.lines) {
        const product = products.get(line.productId);
        if (!product) throw productNotFound();
        if (!product.isActive) throw productInactive();
        if (product.tracksExpiry && !line.expiresAt) throw lotExpiryRequired();
        // Both are YYYY-MM-DD, so string order is date order.
        if (line.expiresAt && line.expiresAt < today) throw lotAlreadyExpired();
      }

      const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
      const receipt = await tx.stockReceipt.create({
        data: {
          tenantId,
          branchId: dto.branchId,
          supplierName: dto.supplierName?.trim() || null,
          documentNumber: dto.documentNumber?.trim() || null,
          receivedAt,
          note: dto.note?.trim() || null,
          createdById: userId,
        },
      });

      for (const line of dto.lines) {
        const unitCost = new Prisma.Decimal(line.unitCost);
        const lot = await tx.stockLot.create({
          data: {
            tenantId,
            productId: line.productId,
            branchId: dto.branchId,
            lotNumber: line.lotNumber?.trim() || null,
            // @db.Date column: UTC midnight of the calendar date.
            expiresAt: line.expiresAt ? new Date(line.expiresAt) : null,
            unitCost,
            quantityReceived: line.quantity,
            quantityOnHand: line.quantity,
            receiptId: receipt.id,
            receivedAt,
          },
        });
        await recordInitialMovement(tx, {
          tenantId,
          actorId: userId,
          lotId: lot.id,
          productId: line.productId,
          branchId: dto.branchId,
          kind: 'RECEIPT',
          quantity: line.quantity,
          unitCost,
          receiptId: receipt.id,
        });
      }

      await recordBillingAudit(tx, {
        tenantId,
        actorId: userId,
        action: 'CREATE',
        entity: 'STOCK_RECEIPT',
        entityId: receipt.id,
        changes: {
          branchId: dto.branchId,
          supplierName: dto.supplierName ?? null,
          documentNumber: dto.documentNumber ?? null,
          lines: dto.lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitCost: line.unitCost,
          })),
        },
      });

      return this.view(tx, tenantId, receipt.id);
    });
  }

  async list(tenantId: string, query: ListStockReceiptsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.StockReceiptWhereInput = {
      tenantId,
      ...(query.branchId ? { branchId: query.branchId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockReceipt.findMany({
        where,
        include: receiptInclude,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockReceipt.count({ where }),
    ]);
    return { items: rows.map(toView), total, page, pageSize };
  }

  async get(tenantId: string, id: string): Promise<StockReceiptView> {
    return this.view(this.prisma, tenantId, id);
  }

  private async view(
    db: Pick<Prisma.TransactionClient, 'stockReceipt'>,
    tenantId: string,
    id: string,
  ): Promise<StockReceiptView> {
    const row = await db.stockReceipt.findFirst({
      where: { id, tenantId },
      include: receiptInclude,
    });
    if (!row) throw stockReceiptNotFound();
    return toView(row);
  }
}

function toView(row: ReceiptRow): StockReceiptView {
  return {
    id: row.id,
    branch: row.branch,
    supplierName: row.supplierName,
    documentNumber: row.documentNumber,
    receivedAt: row.receivedAt,
    note: row.note,
    createdBy: row.createdBy,
    lines: row.lots.map((lot) => ({
      lotId: lot.id,
      product: lot.product,
      quantity: lot.quantityReceived,
      unitCost: lot.unitCost.toFixed(2),
      lotNumber: lot.lotNumber,
      expiresAt: lot.expiresAt,
    })),
  };
}
