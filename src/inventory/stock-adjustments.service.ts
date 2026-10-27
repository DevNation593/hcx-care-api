import { BadRequestException, Injectable } from '@nestjs/common';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { clinicToday } from './clinic-today';
import { CreateStockAdjustmentDto } from './dto/stock-adjustment.dto';
import { isLotExpired } from './fefo';
import {
  adjustmentEmpty,
  adjustmentNoteRequired,
  lotNotFound,
  stockBelowZero,
} from './inventory-errors';
import type { ProductLotView } from './products.service';
import { addToLot, MovementInput, takeFromLot } from './stock-ledger';

@Injectable()
export class StockAdjustmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async adjust(
    tenantId: string,
    userId: string,
    lotId: string,
    dto: CreateStockAdjustmentDto,
  ): Promise<ProductLotView> {
    return runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      const lot = await tx.stockLot.findFirst({ where: { id: lotId, tenantId } });
      if (!lot) throw lotNotFound();

      if ((dto.delta === undefined) === (dto.countedQuantity === undefined)) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'ADJUSTMENT_INPUT_INVALID',
          message: 'Indique solo uno: la variación o la cantidad contada.',
        });
      }
      const delta =
        dto.countedQuantity !== undefined ? dto.countedQuantity - lot.quantityOnHand : dto.delta!;
      if (delta === 0) throw adjustmentEmpty();
      const note = dto.note?.trim() || undefined;
      if (dto.reason === 'OTHER' && !note) throw adjustmentNoteRequired();

      const movement: MovementInput = {
        tenantId,
        actorId: userId,
        lotId: lot.id,
        productId: lot.productId,
        branchId: lot.branchId,
        kind: 'ADJUSTMENT',
        quantity: delta,
        unitCost: lot.unitCost,
        adjustmentReason: dto.reason,
        note,
      };
      if (delta < 0) {
        if (!(await takeFromLot(tx, movement))) throw stockBelowZero();
      } else {
        await addToLot(tx, movement);
      }

      await recordBillingAudit(tx, {
        tenantId,
        actorId: userId,
        action: 'UPDATE',
        entity: 'STOCK_ADJUSTMENT',
        entityId: lot.id,
        changes: {
          productId: lot.productId,
          branchId: lot.branchId,
          delta,
          reason: dto.reason,
          note: note ?? null,
        },
      });

      const updated = await tx.stockLot.findFirst({ where: { id: lot.id, tenantId } });
      if (!updated) throw lotNotFound();
      const today = await clinicToday(tx, tenantId);
      return {
        id: updated.id,
        branchId: updated.branchId,
        lotNumber: updated.lotNumber,
        expiresAt: updated.expiresAt,
        unitCost: updated.unitCost.toFixed(2),
        quantityReceived: updated.quantityReceived,
        quantityOnHand: updated.quantityOnHand,
        receivedAt: updated.receivedAt,
        expired: isLotExpired(updated.expiresAt, today),
      };
    });
  }
}
