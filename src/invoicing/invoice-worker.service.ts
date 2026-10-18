import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InvoiceRequest, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { EmiteFacilProvider } from './provider/emite-facil.provider';
import { InvoiceBody, ProviderDocument, ProviderError } from './provider/invoicing-provider';
import { InvoiceResolver } from './invoice-resolver';
import { InvoiceArtifactsService } from './invoice-artifacts.service';
import { FiscalSnapshot } from './invoice-snapshot';
import { nextInvoiceStatus, retryDelay } from './invoice-state';
@Injectable()
export class InvoiceWorkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    private readonly provider: EmiteFacilProvider,
    private readonly resolver: InvoiceResolver,
    private readonly artifacts: InvoiceArtifactsService,
  ) {}
  @Cron('*/10 * * * * *') async scheduledDispatch() {
    if (process.env.NODE_ENV !== 'test') await this.dispatch();
  }
  @Cron('0 * * * * *') async scheduledReconcile() {
    if (process.env.NODE_ENV !== 'test') await this.reconcile();
  }
  /** Each claim is a short transaction; all HTTP happens after commit. */
  async claim(reconcile = false): Promise<InvoiceRequest[]> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<InvoiceRequest[]>(
        Prisma.sql`SELECT * FROM "InvoiceRequest" WHERE "nextAttemptAt" <= NOW() AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW()) AND ${reconcile ? Prisma.sql`("externalDocumentId" IS NOT NULL AND ("status" = 'PROCESSING' OR ("status" = 'AUTHORIZED' AND ("xmlStorageKey" IS NULL OR "rideStorageKey" IS NULL))))` : Prisma.sql`("externalDocumentId" IS NULL AND ("status" = 'REQUESTED' OR "requiresReconciliation" = true))`} ORDER BY "nextAttemptAt" ASC FOR UPDATE SKIP LOCKED LIMIT ${reconcile ? 50 : 10}`,
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
  async dispatch() {
    for (const row of await this.claim()) await this.process(row);
  }
  async reconcile() {
    for (const row of await this.claim(true)) await this.process(row);
  }
  private lease(row: InvoiceRequest) {
    return { id: row.id, leaseToken: row.leaseToken, leaseUntil: { gt: new Date() } };
  }
  async process(row: InvoiceRequest) {
    let postStarted = false;
    const wasUncertain = row.requiresReconciliation;
    try {
      const c = await this.prisma.invoicingConnection.findUniqueOrThrow({
        where: { id: row.connectionId },
      });
      const client = this.provider.client(
        this.crypto.decrypt(row.tenantId, c.apiKeyEncrypted),
        row.id,
      );
      if (row.status === 'AUTHORIZED') {
        await this.artifacts.collect(row, client);
        await this.release(row);
        return;
      }
      if (row.externalDocumentId) {
        const doc = await client.getDocument(row.externalDocumentId);
        let reason: unknown;
        if (
          nextInvoiceStatus(row.status, doc.state) === 'REJECTED' ||
          doc.state === 'SIGNATURE_FAILED'
        ) {
          try {
            reason = await client.getSriAttempts(doc.id);
          } catch {}
        }
        await this.applyDocument(
          row.id,
          doc,
          'RECONCILER',
          undefined,
          row.leaseToken ?? undefined,
          reason,
        );
        return;
      }
      // A replay never re-resolves customer/catalog/body. Preflight cannot clear prior uncertainty.
      let body: InvoiceBody;
      if (row.providerBodyEncrypted) {
        const text = this.crypto.decrypt(row.tenantId, row.providerBodyEncrypted);
        if (createHash('sha256').update(text).digest('hex') !== row.providerBodyHash)
          throw new ProviderError('configuration', 'INVOICE_BODY_INTEGRITY');
        body = JSON.parse(text);
      } else {
        if (!c.active) throw new ProviderError('configuration', 'INVOICING_DISABLED');
        body = await this.resolver.resolve(row, client);
        const text = JSON.stringify(body);
        const changed = await this.prisma.invoiceRequest.updateMany({
          where: { ...this.lease(row), providerBodyEncrypted: null },
          data: {
            providerBodyEncrypted: this.crypto.encrypt(row.tenantId, text),
            providerBodyHash: createHash('sha256').update(text).digest('hex'),
          },
        });
        if (!changed.count) return;
      }
      // Verify issuer environment even on replay; a mismatch keeps earlier uncertainty blocked.
      const snapshot = JSON.parse(
        this.crypto.decrypt(row.tenantId, row.snapshotEncrypted),
      ) as FiscalSnapshot;
      const issuer = (await client.listTaxpayers()).find((t) => t.id === snapshot.taxpayerId);
      if (!issuer || issuer.defaultEnvironment !== snapshot.environment)
        throw new ProviderError('configuration', 'INVOICING_ENVIRONMENT_CHANGED');
      const marked = await this.prisma.invoiceRequest.updateMany({
        where: this.lease(row),
        data: { requiresReconciliation: true },
      });
      if (!marked.count) return;
      postStarted = true;
      const issued = await client.createInvoice(body, row.providerIdempotencyKey);
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.invoiceRequest.updateMany({
          where: this.lease(row),
          data: {
            externalDocumentId: issued.id,
            externalState: issued.state,
            status: 'PROCESSING',
            requiresReconciliation: false,
            attempts: { increment: 1 },
            nextAttemptAt: new Date(Date.now() + 120000),
            leaseToken: null,
            leaseUntil: null,
            lastErrorEncrypted: null,
          },
        });
        if (changed.count)
          await tx.invoiceRequestEvent.create({
            data: {
              connectionId: row.connectionId,
              invoiceRequestId: row.id,
              type: 'DISPATCHED',
              source: 'DISPATCHER',
              detail: { state: issued.state },
            },
          });
      });
    } catch (error) {
      await this.failed(row, error, wasUncertain, postStarted);
    }
  }
  private async release(row: InvoiceRequest) {
    await this.prisma.invoiceRequest.updateMany({
      where: this.lease(row),
      data: { leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + 120000) },
    });
  }
  private async failed(
    row: InvoiceRequest,
    error: unknown,
    wasUncertain: boolean,
    postStarted: boolean,
  ) {
    const e =
      error instanceof ProviderError
        ? error
        : new ProviderError('transient', 'INVOICING_INTERNAL_ERROR');
    const ambiguous =
      wasUncertain ||
      (postStarted && (e.kind === 'transient' || e.code === 'IDEMPOTENCY_KEY_REUSED'));
    const expired = Date.now() - row.requestedAt.getTime() >= 86400000;
    const safeFailure =
      !row.externalDocumentId && !ambiguous && (e.kind !== 'transient' || expired);
    const status = row.externalDocumentId
      ? row.status
      : safeFailure || expired
        ? 'FAILED'
        : 'REQUESTED';
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.invoiceRequest.updateMany({
        where: this.lease(row),
        data: {
          status,
          requiresReconciliation: ambiguous,
          attempts: { increment: 1 },
          lastErrorEncrypted: this.crypto.encrypt(row.tenantId, JSON.stringify({ code: e.code })),
          nextAttemptAt: new Date(Date.now() + retryDelay(row.attempts + 1, e.retryAfterMs)),
          leaseToken: null,
          leaseUntil: null,
          finishedAt: status === 'FAILED' ? new Date() : null,
        },
      });
      if (!changed.count) return;
      if (safeFailure) await this.releaseOrder(tx, row);
      await tx.invoiceRequestEvent.create({
        data: {
          connectionId: row.connectionId,
          invoiceRequestId: row.id,
          type: safeFailure ? 'FAILED' : 'RETRY_SCHEDULED',
          source: 'DISPATCHER',
          detail: { code: e.code, requiresReconciliation: ambiguous },
        },
      });
    });
  }
  private async releaseOrder(tx: Prisma.TransactionClient, row: InvoiceRequest) {
    await tx.order.update({
      where: { id: row.orderId },
      data: { status: 'PAID', version: { increment: 1 } },
    });
    await tx.treatmentSession.updateMany({
      where: {
        tenantId: row.tenantId,
        completedAt: { not: null },
        orderItems: { some: { orderId: row.orderId, releasedAt: null } },
      },
      data: { status: 'BILLING_FAILED', version: { increment: 1 } },
    });
  }
  async applyDocument(
    id: string,
    doc: ProviderDocument,
    source: 'WEBHOOK' | 'RECONCILER',
    webhookEventId?: string,
    leaseToken?: string,
    reason?: unknown,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        InvoiceRequest[]
      >`SELECT * FROM "InvoiceRequest" WHERE "id"=${id} FOR UPDATE`;
      const row = locked[0];
      if (!row) return;
      if (
        leaseToken &&
        (row.leaseToken !== leaseToken || !row.leaseUntil || row.leaseUntil.getTime() <= Date.now())
      )
        return;
      const snapshot = JSON.parse(
        this.crypto.decrypt(row.tenantId, row.snapshotEncrypted),
      ) as FiscalSnapshot;
      if (
        doc.id !== row.externalDocumentId ||
        doc.taxpayerId !== snapshot.taxpayerId ||
        doc.environment !== snapshot.environment
      )
        throw new ProviderError('configuration', 'INVOICE_DOCUMENT_MISMATCH');
      if (
        webhookEventId &&
        (await tx.invoiceRequestEvent.findUnique({
          where: {
            connectionId_webhookEventId: { connectionId: row.connectionId, webhookEventId },
          },
        }))
      )
        return;
      const status = nextInvoiceStatus(row.status, doc.state);
      const terminal = row.status === 'AUTHORIZED' || row.status === 'REJECTED';
      if (!terminal) {
        await tx.invoiceRequest.update({
          where: { id },
          data: {
            status,
            externalState: doc.state,
            number: doc.number,
            accessKey: doc.accessKey,
            authorizationNumber: doc.authorizationNumber,
            authorizedAt: doc.authorizedAt ? new Date(doc.authorizedAt) : null,
            requiresReconciliation: false,
            leaseToken: null,
            leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + 120000),
            finishedAt: status === 'AUTHORIZED' || status === 'REJECTED' ? new Date() : null,
            lastErrorEncrypted:
              status === 'REJECTED' || doc.state === 'SIGNATURE_FAILED'
                ? this.crypto.encrypt(
                    row.tenantId,
                    JSON.stringify({
                      code: doc.state === 'SIGNATURE_FAILED' ? 'SIGNATURE_FAILED' : 'SRI_REJECTED',
                      attempts: reason ?? [],
                    }),
                  )
                : null,
          },
        });
        if (status === 'REJECTED') await this.releaseOrder(tx, row);
        if (status === 'AUTHORIZED')
          await tx.treatmentSession.updateMany({
            where: {
              tenantId: row.tenantId,
              completedAt: { not: null },
              orderItems: { some: { orderId: row.orderId, releasedAt: null } },
            },
            data: { status: 'BILLED', version: { increment: 1 } },
          });
      }
      await tx.invoiceRequestEvent.create({
        data: {
          connectionId: row.connectionId,
          invoiceRequestId: id,
          type: terminal ? 'PROVIDER_STATE' : status === 'PROCESSING' ? 'PROVIDER_STATE' : status,
          source,
          webhookEventId,
          detail: { state: doc.state, applied: !terminal },
        },
      });
    });
  }
}
