import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { findOpenCashRegister } from '../cash-registers/cash-registers.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { RecordPaymentDto, RefundPaymentDto } from './dto/payment.dto';
import { OrderView, toOrderView } from './order-view';
import { loadOrderForWrite } from './orders.service';

const D = Prisma.Decimal;

const notEditable = () =>
  new ConflictException({
    statusCode: 409,
    code: 'ORDER_NOT_EDITABLE',
    message: 'La orden ya no admite pagos.',
  });

const exceedsBalance = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'PAYMENT_EXCEEDS_BALANCE',
    message: 'El monto supera el saldo pendiente de la orden.',
  });

const keyReused = () =>
  new ConflictException({
    statusCode: 409,
    code: 'IDEMPOTENCY_KEY_REUSED',
    message: 'La clave de idempotencia ya se usó con otro pago.',
  });

const paymentNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'PAYMENT_NOT_FOUND',
    message: 'Pago no encontrado.',
  });

const notRefundable = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PAYMENT_NOT_REFUNDABLE',
    message: 'El pago no se puede devolver.',
  });

function isIdempotencyConflict(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    tenantId: string,
    actorId: string,
    orderId: string,
    dto: RecordPaymentDto,
    idempotencyKey?: string,
  ): Promise<OrderView> {
    try {
      return await this.recordOnce(tenantId, actorId, orderId, dto, idempotencyKey);
    } catch (error) {
      // A concurrent request with the same key committed first: resolve as a repeated key.
      if (idempotencyKey && isIdempotencyConflict(error)) {
        return this.recordOnce(tenantId, actorId, orderId, dto, idempotencyKey);
      }
      throw error;
    }
  }

  private recordOnce(
    tenantId: string,
    actorId: string,
    orderId: string,
    dto: RecordPaymentDto,
    idempotencyKey?: string,
  ): Promise<OrderView> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const amount = new D(dto.amount);
      const reference = dto.reference ?? null;

      if (idempotencyKey) {
        const existing = await tx.payment.findFirst({ where: { tenantId, idempotencyKey } });
        if (existing) {
          const same =
            existing.orderId === orderId &&
            existing.method === dto.method &&
            new D(existing.amount).equals(amount) &&
            (existing.reference ?? null) === reference;
          if (!same) throw keyReused();
          return toOrderView(await loadOrderForWrite(tx, tenantId, orderId));
        }
      }

      const order = await loadOrderForWrite(tx, tenantId, orderId);
      if (order.status !== 'OPEN') throw notEditable();
      const balance = new D(order.total).sub(order.paidTotal);
      if (amount.greaterThan(balance)) throw exceedsBalance();

      const register = await findOpenCashRegister(tx, tenantId, order.branchId);
      const payment = await tx.payment.create({
        data: {
          tenantId,
          orderId,
          cashRegisterSessionId: register.id,
          method: dto.method,
          amount,
          reference,
          idempotencyKey: idempotencyKey ?? null,
          receivedById: actorId,
          receivedAt: new Date(),
        },
      });

      const paidTotal = new D(order.paidTotal).add(amount);
      await tx.order.update({
        where: { id: orderId },
        data: {
          paidTotal,
          status: paidTotal.equals(order.total) ? 'PAID' : 'OPEN',
          version: { increment: 1 },
        },
      });
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'CREATE',
        entity: 'PAYMENT',
        entityId: payment.id,
        changes: {
          orderId,
          method: dto.method,
          amount: amount.toFixed(2),
          cashRegisterSessionId: register.id,
        },
      });
      return toOrderView(await loadOrderForWrite(tx, tenantId, orderId));
    });
  }

  refund(
    tenantId: string,
    actorId: string,
    paymentId: string,
    dto: RefundPaymentDto,
  ): Promise<OrderView> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const payment = await tx.payment.findFirst({ where: { id: paymentId, tenantId } });
      if (!payment) throw paymentNotFound();
      if (payment.status !== 'RECORDED') throw notRefundable();

      const order = await loadOrderForWrite(tx, tenantId, payment.orderId);
      if (order.status !== 'OPEN' && order.status !== 'PAID') throw notRefundable();

      const register = await findOpenCashRegister(tx, tenantId, order.branchId);
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'REFUNDED',
          refundedById: actorId,
          refundedAt: new Date(),
          refundReason: dto.reason,
          refundCashRegisterSessionId: register.id,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          paidTotal: new D(order.paidTotal).sub(payment.amount),
          status: 'OPEN',
          version: { increment: 1 },
        },
      });
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'PAYMENT',
        entityId: payment.id,
        changes: {
          orderId: order.id,
          amount: new D(payment.amount).toFixed(2),
          refundCashRegisterSessionId: register.id,
        },
        reason: dto.reason,
      });
      return toOrderView(await loadOrderForWrite(tx, tenantId, order.id));
    });
  }
}
