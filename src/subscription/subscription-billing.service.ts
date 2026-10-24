import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  SubscriptionPayment,
  SubscriptionPaymentStatus,
  TenantSubscription,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';

const conflict = (code: string, message: string) =>
  new ConflictException({ statusCode: 409, code, message });

/**
 * Charges of the subscription: the renewal of each period, and the first one at the end of a
 * trial. Only the platform changes a clinic's plan. Confirmation is manual today (support, with
 * the reference of the transfer or receipt); a payment provider's webhook can call
 * `confirmPayment` with its own provider name.
 */
@Injectable()
export class SubscriptionBillingService {
  constructor(private readonly prisma: PrismaService) {}

  listForTenant(tenantId: string) {
    return this.prisma.subscriptionPayment.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  listAll(status?: SubscriptionPaymentStatus) {
    return this.prisma.subscriptionPayment.findMany({
      where: status ? { status } : {},
      include: { tenant: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Applies a payment exactly once. Repeating the call with the same reference returns the
   * stored result without touching the subscription again.
   */
  async confirmPayment(
    paymentId: string,
    actorId: string | null,
    input: { reference: string; note?: string; provider?: string },
  ) {
    const found = await this.prisma.subscriptionPayment.findUnique({ where: { id: paymentId } });
    if (!found) throw new NotFoundException('Pago no encontrado');
    const provider = input.provider ?? found.provider;
    const now = new Date();

    try {
      return await runSerializableTransaction(
        this.prisma,
        found.tenantId,
        actorId ?? '',
        async (tx) => {
          const payment = await tx.subscriptionPayment.findUniqueOrThrow({
            where: { id: paymentId },
          });

          if (payment.status === 'CONFIRMED') {
            if (payment.provider === provider && payment.providerReference === input.reference) {
              return { success: true, alreadyConfirmed: true, payment };
            }
            throw conflict(
              'PAYMENT_ALREADY_CONFIRMED',
              'Este pago ya fue confirmado con otra referencia.',
            );
          }
          if (payment.status !== 'PENDING') {
            throw conflict(
              'PAYMENT_NOT_PENDING',
              `El pago está ${payment.status} y ya no se puede confirmar.`,
            );
          }

          const reused = await tx.subscriptionPayment.findFirst({
            where: { provider, providerReference: input.reference, id: { not: paymentId } },
            select: { id: true },
          });
          if (reused) throw this.referenceAlreadyUsed();

          const subscription = await tx.tenantSubscription.findUniqueOrThrow({
            where: { tenantId: payment.tenantId },
          });
          if (payment.kind === 'PLAN_UPGRADE') {
            throw conflict(
              'PAYMENT_NO_LONGER_APPLICABLE',
              'Los consultorios ya no cambian de plan con un pago: rechace este pago y cambie el plan desde el panel.',
            );
          }
          const updated = await this.applyRenewal(tx, subscription, payment, actorId);

          const confirmed = await tx.subscriptionPayment.update({
            where: { id: paymentId },
            data: {
              status: 'CONFIRMED',
              provider,
              providerReference: input.reference,
              resolvedById: actorId,
              resolvedAt: now,
              resolutionNote: input.note,
            },
          });

          await tx.subscriptionEvent.create({
            data: {
              tenantId: payment.tenantId,
              eventType: 'PAYMENT_SUCCEEDED',
              previousStatus: subscription.status,
              newStatus: updated.status,
              metadata: {
                paymentId,
                kind: payment.kind,
                amount: Number(payment.amount),
                provider,
                reference: input.reference,
              },
              triggeredByUserId: actorId,
            },
          });

          return {
            success: true,
            alreadyConfirmed: false,
            payment: confirmed,
            subscription: updated,
          };
        },
      );
    } catch (error) {
      // Two confirmations racing with the same reference: the unique index decides.
      if ((error as { code?: string }).code === 'P2002') throw this.referenceAlreadyUsed();
      throw error;
    }
  }

  async rejectPayment(paymentId: string, actorId: string, reason: string) {
    const found = await this.prisma.subscriptionPayment.findUnique({ where: { id: paymentId } });
    if (!found) throw new NotFoundException('Pago no encontrado');

    return runSerializableTransaction(this.prisma, found.tenantId, actorId, async (tx) => {
      const payment = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });
      if (payment.status === 'REJECTED') return { success: true, payment };
      if (payment.status !== 'PENDING') {
        throw conflict(
          'PAYMENT_NOT_PENDING',
          `El pago está ${payment.status} y ya no se puede rechazar.`,
        );
      }

      const rejected = await tx.subscriptionPayment.update({
        where: { id: paymentId },
        data: {
          status: 'REJECTED',
          resolvedById: actorId,
          resolvedAt: new Date(),
          resolutionNote: reason,
        },
      });
      await tx.subscriptionEvent.create({
        data: {
          tenantId: payment.tenantId,
          eventType: 'PAYMENT_FAILED',
          reason,
          metadata: { paymentId, kind: payment.kind, amount: Number(payment.amount) },
          triggeredByUserId: actorId,
        },
      });

      return { success: true, payment: rejected };
    });
  }

  private async applyRenewal(
    tx: Prisma.TransactionClient,
    subscription: TenantSubscription,
    payment: SubscriptionPayment,
    actorId: string | null,
  ) {
    const updated = await tx.tenantSubscription.update({
      where: { tenantId: subscription.tenantId },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: payment.periodStart ?? subscription.currentPeriodStart,
        currentPeriodEnd: payment.periodEnd,
      },
    });

    if (subscription.status !== 'ACTIVE') {
      await tx.subscriptionEvent.create({
        data: {
          tenantId: subscription.tenantId,
          eventType: 'SUBSCRIPTION_REACTIVATED',
          previousStatus: subscription.status,
          newStatus: 'ACTIVE',
          metadata: { paymentId: payment.id },
          triggeredByUserId: actorId,
        },
      });
    }

    return updated;
  }

  private referenceAlreadyUsed() {
    return conflict(
      'PAYMENT_REFERENCE_ALREADY_USED',
      'Esa referencia ya se usó para confirmar otro pago.',
    );
  }
}
