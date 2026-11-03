import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InvoiceRequest, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { InvoiceEmitter } from './invoice-emitter';
import { releaseOrder, retryDelay } from './invoice-state';
import { SriError } from './sri/sri-types';
/** The emitter never starts an SRI call with less than this left, so neither does a tick. */
const MIN_START_MS = 4000;
/** No claim reaches a halted row; intervention resets its nextAttemptAt. */
const HALTED_UNTIL = new Date('9999-12-31T00:00:00Z');
@Injectable()
export class InvoiceWorkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    private readonly emitter: InvoiceEmitter,
  ) {}
  /** Opt-in: serverless deployments are driven by the secret-protected tick instead. */
  private internalSchedulerEnabled() {
    return process.env.INVOICING_INTERNAL_SCHEDULER === 'true' && process.env.NODE_ENV !== 'test';
  }
  @Cron('*/10 * * * * *') async scheduledDispatch() {
    if (this.internalSchedulerEnabled()) await this.dispatch();
  }
  @Cron('0 * * * * *') async scheduledReconcile() {
    if (this.internalSchedulerEnabled()) await this.reconcile();
  }
  /** Each claim is a short transaction; all SRI work happens after commit. */
  async claim(reconcile = false, id?: string): Promise<InvoiceRequest[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<InvoiceRequest[]>(
        Prisma.sql`SELECT * FROM "InvoiceRequest" WHERE "nextAttemptAt" <= NOW() AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW()) AND ${id === undefined ? Prisma.empty : Prisma.sql`"id" = ${id} AND `}${reconcile ? Prisma.sql`("status" = 'PROCESSING' OR ("status" = 'AUTHORIZED' AND ("xmlStorageKey" IS NULL OR "rideStorageKey" IS NULL OR ("emailedAt" IS NULL AND "emailAttempts" < 5))))` : Prisma.sql`"status" IN ('REQUESTED','PROCESSING')`} ORDER BY "nextAttemptAt" ASC FOR UPDATE SKIP LOCKED LIMIT ${reconcile ? 50 : 10}`,
      );
      const claimed: InvoiceRequest[] = [];
      for (const row of rows) {
        claimed.push(
          await tx.invoiceRequest.update({
            where: { id: row.id },
            data: { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 120000) },
          }),
        );
      }
      return claimed;
    });
  }
  /** Inline attempt: claims that one row (if nobody else holds it) and advances it within the budget. */
  async processOne(id: string, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    for (const row of await this.claim(false, id)) await this.process(row, deadline);
  }
  /** Successive claims (normal, then reconcile) until the budget is spent or nothing is due. */
  async tick(budgetMs: number): Promise<{ processed: number }> {
    const deadline = Date.now() + budgetMs;
    let processed = 0;
    while (deadline - Date.now() >= MIN_START_MS) {
      let rows = await this.claim();
      if (!rows.length) rows = await this.claim(true);
      if (!rows.length) break;
      for (const row of rows) {
        if (deadline - Date.now() < MIN_START_MS) return { processed };
        await this.process(row, deadline);
        processed++;
      }
    }
    return { processed };
  }
  async dispatch() {
    for (const row of await this.claim()) await this.process(row);
  }
  async reconcile() {
    for (const row of await this.claim(true)) await this.process(row);
  }
  private lease(row: InvoiceRequest) {
    return { id: row.id, leaseToken: row.leaseToken, leaseUntil: { gt: new Date() } };
  }
  async process(row: InvoiceRequest, deadline = Date.now() + 100000) {
    try {
      // The default deadline leaves 20 s of the 120 s lease to persist the last step.
      await this.emitter.advance(row, deadline);
    } catch (error) {
      await this.failed(row, error);
    }
  }
  private async failed(row: InvoiceRequest, error: unknown) {
    const e =
      error instanceof SriError ? error : new SriError('transient', 'INVOICING_INTERNAL_ERROR');
    const expired = Date.now() - row.requestedAt.getTime() >= 86400000;
    await this.prisma.$transaction(async (tx) => {
      // The emitter may have signed during this pass: decide from the stored row, not the claim.
      const current = await tx.invoiceRequest.findFirst({ where: this.lease(row) });
      if (!current) return;
      // An authorized invoice never records a failure: it only frees the lease and backs off.
      if (current.status === 'AUTHORIZED') {
        await tx.invoiceRequest.updateMany({
          where: this.lease(row),
          data: {
            attempts: { increment: 1 },
            nextAttemptAt: new Date(Date.now() + retryDelay(current.attempts + 1)),
            leaseToken: null,
            leaseUntil: null,
          },
        });
        return;
      }
      // Signed XML may still reach the SRI, so the request never fails and keeps its order.
      const signed = !!current.signedXmlStorageKey;
      const safeFailure = !signed && (e.kind !== 'transient' || expired);
      // Signed XML whose bytes were altered can never be sent: stop until someone intervenes.
      const halted = signed && e.code === 'INVOICE_SIGNED_XML_INTEGRITY';
      const status = signed ? current.status : safeFailure ? 'FAILED' : 'REQUESTED';
      const changed = await tx.invoiceRequest.updateMany({
        where: this.lease(row),
        data: {
          status,
          attempts: { increment: 1 },
          lastErrorEncrypted: this.crypto.encrypt(row.tenantId, JSON.stringify({ code: e.code })),
          nextAttemptAt: halted
            ? HALTED_UNTIL
            : new Date(Date.now() + retryDelay(current.attempts + 1, e.retryAfterMs)),
          leaseToken: null,
          leaseUntil: null,
          finishedAt: status === 'FAILED' ? new Date() : null,
        },
      });
      if (!changed.count) return;
      if (safeFailure) await releaseOrder(tx, row);
      await tx.invoiceRequestEvent.create({
        data: {
          issuerId: row.issuerId,
          invoiceRequestId: row.id,
          type: safeFailure ? 'FAILED' : halted ? 'INTEGRITY_HALTED' : 'RETRY_SCHEDULED',
          source: 'DISPATCHER',
          detail: { code: e.code },
        },
      });
    });
  }
}
