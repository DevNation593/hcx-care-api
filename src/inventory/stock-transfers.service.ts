import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assertBranchAvailable } from '../branches/branches.service';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { CreateStockTransferDto, ListStockTransfersQuery } from './dto/stock-transfer.dto';
import {
  insufficientStock,
  lotNotFound,
  lotNotInBranch,
  transferSameBranch,
} from './inventory-errors';
import { recordInitialMovement, takeFromLot } from './stock-ledger';

const DEFAULT_PAGE_SIZE = 20;

export interface StockTransferLineView {
  sourceLotId: string | null;
  lotId: string;
  product: { id: string; code: string; name: string };
  quantity: number;
  unitCost: string;
  lotNumber: string | null;
  expiresAt: Date | null;
}

export interface StockTransferView {
  id: string;
  fromBranch: { id: string; name: string };
  toBranch: { id: string; name: string };
  note: string | null;
  createdAt: Date;
  createdBy: { id: string; firstName: string; lastName: string };
  lines: StockTransferLineView[];
}

const transferInclude = {
  fromBranch: { select: { id: true, name: true } },
  toBranch: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  // The TRANSFER_IN movement of each line points at the lot created at the destination.
  movements: {
    where: { kind: 'TRANSFER_IN' as const },
    orderBy: { id: 'asc' as const },
    include: {
      lot: { include: { product: { select: { id: true, code: true, name: true } } } },
    },
  },
} satisfies Prisma.StockTransferInclude;

type TransferRow = Prisma.StockTransferGetPayload<{ include: typeof transferInclude }>;

const transferNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'STOCK_TRANSFER_NOT_FOUND',
    message: 'Traslado no encontrado.',
  });

@Injectable()
export class StockTransfersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    tenantId: string,
    userId: string,
    dto: CreateStockTransferDto,
  ): Promise<StockTransferView> {
    if (dto.fromBranchId === dto.toBranchId) throw transferSameBranch();

    return runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      await assertBranchAvailable(tx, tenantId, dto.fromBranchId);
      await assertBranchAvailable(tx, tenantId, dto.toBranchId);

      // Ascending lot id: the same lock order as release and the sale path.
      const lines = [...dto.lines].sort((a, b) =>
        a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0,
      );
      const lots = new Map(
        (
          await tx.stockLot.findMany({
            where: { tenantId, id: { in: lines.map((line) => line.lotId) } },
          })
        ).map((lot) => [lot.id, lot]),
      );
      // Validate every line before writing anything.
      for (const line of lines) {
        const lot = lots.get(line.lotId);
        if (!lot) throw lotNotFound();
        if (lot.branchId !== dto.fromBranchId) throw lotNotInBranch();
      }

      const note = dto.note?.trim() || null;
      const transfer = await tx.stockTransfer.create({
        data: {
          tenantId,
          fromBranchId: dto.fromBranchId,
          toBranchId: dto.toBranchId,
          note,
          createdById: userId,
        },
      });

      for (const line of lines) {
        const lot = lots.get(line.lotId)!;
        const taken = await takeFromLot(tx, {
          tenantId,
          actorId: userId,
          lotId: lot.id,
          productId: lot.productId,
          branchId: lot.branchId,
          kind: 'TRANSFER_OUT',
          quantity: -line.quantity,
          unitCost: lot.unitCost,
          transferId: transfer.id,
        });
        if (!taken) throw insufficientStock(lot.quantityOnHand);

        const arrived = await tx.stockLot.create({
          data: {
            tenantId,
            productId: lot.productId,
            branchId: dto.toBranchId,
            lotNumber: lot.lotNumber,
            expiresAt: lot.expiresAt,
            unitCost: lot.unitCost,
            quantityReceived: line.quantity,
            quantityOnHand: line.quantity,
            sourceLotId: lot.id,
            receivedAt: lot.receivedAt,
          },
        });
        await recordInitialMovement(tx, {
          tenantId,
          actorId: userId,
          lotId: arrived.id,
          productId: lot.productId,
          branchId: dto.toBranchId,
          kind: 'TRANSFER_IN',
          quantity: line.quantity,
          unitCost: lot.unitCost,
          transferId: transfer.id,
        });
      }

      await recordBillingAudit(tx, {
        tenantId,
        actorId: userId,
        action: 'CREATE',
        entity: 'STOCK_TRANSFER',
        entityId: transfer.id,
        changes: {
          fromBranchId: dto.fromBranchId,
          toBranchId: dto.toBranchId,
          lines: lines.map((line) => ({ lotId: line.lotId, quantity: line.quantity })),
        },
      });

      return this.view(tx, tenantId, transfer.id);
    });
  }

  async list(tenantId: string, query: ListStockTransfersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.StockTransferWhereInput = {
      tenantId,
      ...(query.branchId
        ? { OR: [{ fromBranchId: query.branchId }, { toBranchId: query.branchId }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockTransfer.findMany({
        where,
        include: transferInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);
    return { items: rows.map(toView), total, page, pageSize };
  }

  async get(tenantId: string, id: string): Promise<StockTransferView> {
    return this.view(this.prisma, tenantId, id);
  }

  private async view(
    db: Pick<Prisma.TransactionClient, 'stockTransfer'>,
    tenantId: string,
    id: string,
  ): Promise<StockTransferView> {
    const row = await db.stockTransfer.findFirst({
      where: { id, tenantId },
      include: transferInclude,
    });
    if (!row) throw transferNotFound();
    return toView(row);
  }
}

function toView(row: TransferRow): StockTransferView {
  return {
    id: row.id,
    fromBranch: row.fromBranch,
    toBranch: row.toBranch,
    note: row.note,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    lines: row.movements.map((movement) => ({
      sourceLotId: movement.lot.sourceLotId,
      lotId: movement.lot.id,
      product: movement.lot.product,
      quantity: movement.quantity,
      unitCost: movement.unitCost.toFixed(2),
      lotNumber: movement.lot.lotNumber,
      expiresAt: movement.lot.expiresAt,
    })),
  };
}
