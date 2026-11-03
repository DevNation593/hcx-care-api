import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { loadOrderBillingFacts } from '../orders/eligibility-facts';
import {
  billingBlocked,
  evaluateBillingEligibility,
  FINAL_CONSUMER_LIMIT,
} from '../orders/billing-eligibility';
import { invoiceView } from './invoice-view';
import { FiscalSnapshot, groupedPayments } from './invoice-snapshot';
import { invoiceError } from './invoice-errors';
import { SriEnvironment } from './sri/sri-types';
import { ListInvoiceRequestsQuery } from './dto/invoicing.dto';
export const blockingInvoiceWhere: Prisma.InvoiceRequestWhereInput = {
  OR: [
    { status: { in: ['REQUESTED', 'PROCESSING', 'AUTHORIZED'] } },
    { requiresReconciliation: true },
  ],
};
/** UTC-5 fiscal month (Ecuador does not observe daylight saving). */
export function fiscalMonthStart(now = new Date()) {
  const fiscal = new Date(now.getTime() - 5 * 3600000);
  return new Date(Date.UTC(fiscal.getUTCFullYear(), fiscal.getUTCMonth(), 1, 5));
}
export async function invoiceMonthlyUsage(
  tx: Pick<Prisma.TransactionClient, 'invoiceRequest'>,
  tenantId: string,
) {
  const rows = await tx.invoiceRequest.findMany({
    where: { tenantId, requestedAt: { gte: fiscalMonthStart() }, ...blockingInvoiceWhere },
    select: { rootRequestId: true },
    distinct: ['rootRequestId'],
  });
  return rows.length;
}
@Injectable()
export class InvoiceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
  ) {}
  async create(tenantId: string, userId: string, orderId: string, key: string) {
    if (!key || !/^[A-Za-z0-9._:-]{1,100}$/.test(key))
      throw invoiceError('IDEMPOTENCY_KEY_INVALID', 400);
    if (!this.crypto.enabled) throw invoiceError('INVOICING_ENCRYPTION_REQUIRED', 503);
    try {
      return await runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
        const repeated = await tx.invoiceRequest.findUnique({
          where: { tenantId_clientIdempotencyKey: { tenantId, clientIdempotencyKey: key } },
        });
        if (repeated) {
          if (repeated.orderId !== orderId) throw invoiceError('IDEMPOTENCY_KEY_REUSED');
          return invoiceView(repeated, this.crypto, { includeError: false });
        }
        const order = await tx.order.findFirst({
          where: { id: orderId, tenantId },
          include: {
            billingProfile: true,
            items: {
              where: { releasedAt: null },
              orderBy: { id: 'asc' },
              include: {
                treatmentSession: {
                  select: {
                    treatmentVersionId: true,
                    treatmentVersion: { select: { treatment: { select: { code: true } } } },
                  },
                },
                product: { select: { code: true } },
              },
            },
            payments: { where: { status: 'RECORDED' } },
          },
        });
        if (!order) throw invoiceError('ORDER_NOT_FOUND', 404);
        const blocking = await tx.invoiceRequest.findFirst({
          where: { tenantId, orderId, ...blockingInvoiceWhere },
        });
        if (blocking)
          throw invoiceError(
            blocking.status === 'AUTHORIZED'
              ? 'ORDER_ALREADY_AUTHORIZED'
              : blocking.requiresReconciliation
                ? 'INVOICE_RECONCILIATION_REQUIRED'
                : 'INVOICE_REQUEST_IN_PROGRESS',
          );
        if (order.status !== 'PAID') throw invoiceError('ORDER_NOT_BILLABLE', 422);
        const facts = await loadOrderBillingFacts(tx, tenantId, orderId, new Date());
        const eligibility = evaluateBillingEligibility(facts);
        if (!eligibility.eligible) throw billingBlocked(eligibility);
        const issuer = await tx.invoicingIssuer.findUnique({ where: { tenantId } });
        if (!issuer?.active || !issuer.certificateEncrypted)
          throw invoiceError('INVOICING_NOT_CONFIGURED', 422);
        const p = await tx.branchEmissionPoint.findFirst({
          where: { branchId: order.branchId, issuerId: issuer.id },
        });
        if (!p?.establishmentAddress) throw invoiceError('INVOICING_NOT_CONFIGURED', 422);
        const profile = order.billingProfile!;
        if (profile.idType === '07' && new Prisma.Decimal(order.total).gt(FINAL_CONSUMER_LIMIT))
          throw invoiceError('FINAL_CONSUMER_LIMIT', 422);
        const previous = await tx.invoiceRequest.findFirst({
          where: { tenantId, orderId },
          orderBy: { requestedAt: 'desc' },
        });
        const sub = await tx.tenantSubscription.findUnique({ where: { tenantId } });
        const usage = await invoiceMonthlyUsage(tx, tenantId);
        if (!sub || usage >= sub.monthlyElectronicInvoicesLimit)
          throw invoiceError('INVOICE_LIMIT_REACHED');
        const id = randomUUID();
        const snapshot: FiscalSnapshot = {
          customer: {
            idType: profile.idType,
            idNumber: profile.idNumber,
            name: profile.legalName,
            email: profile.email,
            address: profile.address,
            phone: profile.phone,
          },
          issuerId: issuer.id,
          issuer: {
            ruc: issuer.ruc,
            legalName: issuer.legalName,
            tradeName: issuer.tradeName,
            headOfficeAddress: issuer.headOfficeAddress,
            accountingRequired: issuer.accountingRequired,
            specialTaxpayerCode: issuer.specialTaxpayerCode,
            withholdingAgentCode: issuer.withholdingAgentCode,
            rimpeRegime: issuer.rimpeRegime,
          },
          environment: issuer.environment as SriEnvironment,
          establishmentCode: p.establishmentCode,
          emissionPointCode: p.emissionPointCode,
          establishmentAddress: p.establishmentAddress,
          issueDate: new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10),
          lines: order.items.map((i) => ({
            localId:
              i.kind === 'TREATMENT_SESSION'
                ? i.treatmentSession!.treatmentVersionId
                : i.kind === 'PRODUCT'
                  ? i.productId!
                  : i.id,
            ...(i.kind === 'TREATMENT_SESSION'
              ? { code: i.treatmentSession!.treatmentVersion.treatment.code }
              : i.kind === 'PRODUCT'
                ? { code: i.product!.code }
                : {}),
            name: i.description,
            quantity: i.quantity.toFixed(6),
            unitPrice: i.unitPrice.toFixed(2),
            discount: i.discount.toFixed(2),
            taxRatePercent: i.taxRatePercent.toFixed(2),
          })),
          payments: groupedPayments(order.payments, order.total),
        };
        const row = await tx.invoiceRequest.create({
          data: {
            id,
            tenantId,
            orderId,
            issuerId: issuer.id,
            billingProfileId: profile.id,
            requestedById: userId,
            clientIdempotencyKey: key,
            snapshotEncrypted: this.crypto.encrypt(tenantId, JSON.stringify(snapshot)),
            rootRequestId: previous?.rootRequestId ?? id,
            replacesInvoiceRequestId: previous?.id,
            events: {
              create: { issuerId: issuer.id, type: 'REQUESTED', source: 'API', detail: {} },
            },
          },
        });
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'INVOICED', version: { increment: 1 } },
        });
        // Incomplete early-billed care keeps its clinical state and remains completable.
        await tx.treatmentSession.updateMany({
          where: {
            tenantId,
            id: {
              in: order.items.flatMap((i) => (i.treatmentSessionId ? [i.treatmentSessionId] : [])),
            },
            completedAt: { not: null },
          },
          data: { status: 'BILLING_PENDING', version: { increment: 1 } },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            entity: 'INVOICE_REQUEST',
            entityId: id,
            action: 'CREATE',
            changes: { orderId },
          },
        });
        return invoiceView(row, this.crypto, { includeError: false });
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        const repeated = await this.prisma.invoiceRequest.findUnique({
          where: { tenantId_clientIdempotencyKey: { tenantId, clientIdempotencyKey: key } },
        });
        if (repeated) {
          if (repeated.orderId !== orderId) throw invoiceError('IDEMPOTENCY_KEY_REUSED');
          return invoiceView(repeated, this.crypto, { includeError: false });
        }
        throw invoiceError('INVOICE_REQUEST_IN_PROGRESS');
      }
      throw e;
    }
  }
  async list(tenantId: string, q: ListInvoiceRequestsQuery) {
    const where: Prisma.InvoiceRequestWhereInput = {
      tenantId,
      status: q.status,
      orderId: q.orderId,
      order: {
        branchId: q.branchId,
        ...(q.patientId ? { items: { some: { patientId: q.patientId } } } : {}),
      },
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoiceRequest.findMany({
        where,
        include: { order: { select: { number: true, branchId: true } } },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.invoiceRequest.count({ where }),
    ]);
    return {
      items: rows.map((r) => invoiceView(r, this.crypto)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }
  /** Current state of one request of the tenant (used to answer right after the inline attempt). */
  view(tenantId: string, id: string) {
    return this.get(tenantId, id);
  }
  async get(tenantId: string, id: string) {
    const r = await this.prisma.invoiceRequest.findFirst({
      where: { tenantId, id },
      include: {
        order: { select: { number: true, branchId: true } },
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!r) throw invoiceError('INVOICE_REQUEST_NOT_FOUND', 404);
    return invoiceView(r, this.crypto);
  }
}
