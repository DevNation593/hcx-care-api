import { Inject, Injectable } from '@nestjs/common';
import { InvoiceRequest, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { InvoiceArtifactsService } from './invoice-artifacts.service';
import { InvoiceDeliveryService, MAX_EMAIL_ATTEMPTS } from './invoice-delivery.service';
import { IssuerService } from './issuer.service';
import { FiscalSnapshot, toInvoiceDocument } from './invoice-snapshot';
import {
  billSessions,
  nextInvoiceStatus,
  releaseOrder,
  retryDelay,
  SriStage,
} from './invoice-state';
import { buildAccessKey, newNumericCode } from './sri/access-key';
import { assertCertificateFor, SigningMaterial } from './sri/certificate';
import { buildInvoiceXml, invoiceNumber } from './sri/invoice-xml';
import { AuthorizationResult, hasMessage, SriCallOptions, SriClient } from './sri/sri-client';
import { SriError, SriMessage } from './sri/sri-types';
import { signInvoiceXml } from './sri/xades-signer';
import { verifyInvoiceSignature } from './sri/xades-verifier';

/** No SRI call starts with less time left than this; the tick resumes the row instead. */
const MIN_CALL_MS = 4000;
/** An SRI call never waits longer than this, and ends this long before the deadline. */
const MAX_CALL_MS = 15000;
const CALL_MARGIN_MS = 1000;
/** Inline: up to two authorization queries, each after a 3 s wait. Later ones are the tick's. */
const POLL_WAIT_MS = 3000;
const INLINE_POLLS = 2;

/** Options for an SRI call started after waitMs, or null when the budget cannot fit one. */
function callBudget(deadline: number, waitMs = 0): SriCallOptions | null {
  const remaining = deadline - Date.now() - waitMs;
  if (remaining < MIN_CALL_MS) return null;
  return { timeoutMs: Math.min(MAX_CALL_MS, remaining - CALL_MARGIN_MS) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rolls the signing transaction back when another worker took the lease meanwhile. */
class LeaseLost extends Error {}

/**
 * Moves one leased invoice request through the SRI emission steps. Every step persists its
 * result, so a later pass resumes where the previous one stopped.
 */
@Injectable()
export class InvoiceEmitter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    private readonly issuers: IssuerService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly sri: SriClient,
    private readonly artifacts: InvoiceArtifactsService,
    private readonly delivery: InvoiceDeliveryService,
  ) {}

  /** Throws SriError; a configuration error before signing fails the request safely. */
  async advance(row: InvoiceRequest, deadline: number): Promise<void> {
    // An authorized row is claimed again only for the files and the e-mail it still lacks.
    if (row.status === 'AUTHORIZED') return this.finish(row, deadline);
    if (row.status !== 'REQUESTED' && row.status !== 'PROCESSING') return;
    let signed: InvoiceRequest | null = row;
    // Signed XML is final: the request never gets another sequential or access key.
    if (!row.signedXmlStorageKey) {
      if (Date.now() >= deadline) return;
      signed = await this.sign(row);
      if (!signed) return;
    }
    await this.transmit(signed, deadline);
  }

  /**
   * Steps c and d. A signed request only ends AUTHORIZED or REJECTED, as the SRI says; while the
   * SRI has no answer the lease is released and the reconcile claim resumes it later.
   */
  private async transmit(row: InvoiceRequest, deadline: number): Promise<void> {
    const s = this.snapshot(row);
    const accessKey = row.accessKey!;
    let current = row;
    let waitFirst = false;
    if (row.externalState !== 'RECEIVED') {
      const first = callBudget(deadline);
      if (!first) return this.park(row);
      // An earlier pass may have sent it and failed before recording the answer: ask first.
      const known = await this.sri.authorize(s.environment, accessKey, first);
      if (known.outcome !== 'PENDING') return this.settle(row, s, known, deadline);
      // No authorizations at all: the SRI does not know this access key yet.
      if (known.sriStatus === null) {
        const bytes = await this.signedBytes(row);
        const budget = callBudget(deadline);
        if (!budget) return this.park(row);
        const reception = await this.sri.send(s.environment, bytes, budget);
        // 43 (access key registered) and 70 (key in process) mean the SRI already has it.
        if (
          reception.outcome === 'RETURNED' &&
          !hasMessage(reception, '43') &&
          !hasMessage(reception, '70')
        ) {
          await this.applyStage(row, 'RETURNED', {}, reception.messages);
          return;
        }
      }
      const received = await this.applyStage(row, 'RECEIVED');
      if (!received) return;
      current = received;
      waitFirst = true;
    }
    for (let poll = 0; poll < INLINE_POLLS; poll++) {
      const wait = poll > 0 || waitFirst ? POLL_WAIT_MS : 0;
      if (!callBudget(deadline, wait)) return this.park(current);
      if (wait) await sleep(wait);
      const budget = callBudget(deadline);
      if (!budget) return this.park(current);
      const answer = await this.sri.authorize(s.environment, accessKey, budget);
      if (answer.outcome !== 'PENDING') return this.settle(current, s, answer, deadline);
    }
    await this.park(current);
  }

  private async settle(
    row: InvoiceRequest,
    s: FiscalSnapshot,
    answer: AuthorizationResult,
    deadline: number,
  ): Promise<void> {
    if (answer.outcome === 'AUTHORIZED') {
      const authorized = await this.applyStage(row, 'AUTHORIZED', {
        number: invoiceNumber({
          establishmentCode: s.establishmentCode,
          emissionPointCode: s.emissionPointCode,
          sequential: Number(row.sequential),
        }),
        authorizationNumber: answer.authorizationNumber,
        authorizedAt: answer.authorizedAt,
      });
      if (authorized) await this.finish(authorized, deadline);
    } else {
      await this.applyStage(row, 'NOT_AUTHORIZED', {}, answer.messages);
    }
  }

  /**
   * Records an SRI answer under the lease. AUTHORIZED bills the sessions and REJECTED releases the
   * order; SRI messages only ever go encrypted into lastErrorEncrypted. Null when the lease was lost.
   */
  private async applyStage(
    row: InvoiceRequest,
    stage: SriStage,
    data: Partial<Pick<InvoiceRequest, 'number' | 'authorizationNumber' | 'authorizedAt'>> = {},
    messages: SriMessage[] = [],
  ): Promise<InvoiceRequest | null> {
    return this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<InvoiceRequest[]>`
        SELECT * FROM "InvoiceRequest" WHERE "id" = ${row.id} FOR UPDATE`;
      if (
        !current ||
        current.status !== 'PROCESSING' ||
        current.leaseToken !== row.leaseToken ||
        !current.leaseUntil ||
        current.leaseUntil.getTime() <= Date.now()
      )
        return null;
      const status = nextInvoiceStatus(current.status, stage);
      const final = status !== 'PROCESSING';
      const updated = await tx.invoiceRequest.update({
        where: { id: row.id },
        data: {
          ...data,
          status,
          externalState: stage,
          lastErrorEncrypted:
            status === 'REJECTED'
              ? this.crypto.encrypt(
                  row.tenantId,
                  JSON.stringify({ code: 'SRI_REJECTED', messages }),
                )
              : null,
          // A final answer frees the row, except an AUTHORIZED one: this pass keeps its lease to
          // store the files and send the e-mail, and finish() frees it.
          ...(final
            ? {
                ...(status === 'AUTHORIZED' ? {} : { leaseToken: null, leaseUntil: null }),
                nextAttemptAt: new Date(),
                finishedAt: new Date(),
              }
            : {}),
        },
      });
      if (status === 'REJECTED') await releaseOrder(tx, current);
      if (status === 'AUTHORIZED') await billSessions(tx, current);
      await tx.invoiceRequestEvent.create({
        data: {
          issuerId: row.issuerId,
          connectionId: null,
          invoiceRequestId: row.id,
          type: final ? status : stage,
          source: 'DISPATCHER',
          detail: { stage },
        },
      });
      return updated;
    });
  }

  /**
   * Steps e and f for an authorized row, while the budget lasts, and then the lease is freed. What
   * is still pending (a file, an e-mail to retry) is resumed by the reconcile claim after a backoff.
   */
  private async finish(row: InvoiceRequest, deadline: number): Promise<void> {
    // Nothing here may throw: the row is already AUTHORIZED and a failure must not be recorded on it.
    // Whatever stays pending is resumed after the lease expires or the backoff below.
    try {
      if (deadline - Date.now() >= MIN_CALL_MS) {
        await this.guarded(() => this.artifacts.collect(row));
        if (deadline - Date.now() >= MIN_CALL_MS)
          await this.guarded(() => this.delivery.deliver(row));
      }
      await this.release(row);
    } catch {
      /* The lease expires and the reconcile claim retries. */
    }
  }

  private async guarded(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch {
      /* Counted as pending by release(). */
    }
  }

  private async release(row: InvoiceRequest): Promise<void> {
    const where = { id: row.id, leaseToken: row.leaseToken, leaseUntil: { gt: new Date() } };
    const current = await this.prisma.invoiceRequest.findFirst({ where });
    if (!current) return;
    const lackingFiles = !current.xmlStorageKey || !current.rideStorageKey;
    const pending =
      lackingFiles || (!current.emailedAt && current.emailAttempts < MAX_EMAIL_ATTEMPTS);
    // A failed e-mail already scheduled its own retry; anything else waits one backoff step.
    const backoff = pending && current.nextAttemptAt.getTime() <= Date.now();
    await this.prisma.invoiceRequest.updateMany({
      where,
      data: {
        leaseToken: null,
        leaseUntil: null,
        ...(backoff
          ? {
              attempts: { increment: 1 },
              nextAttemptAt: new Date(
                Date.now() +
                  retryDelay(lackingFiles ? current.attempts + 1 : current.emailAttempts + 1),
              ),
            }
          : {}),
      },
    });
  }

  /** Still waiting for the SRI: free the lease and let the reconcile claim resume after a backoff. */
  private async park(row: InvoiceRequest): Promise<void> {
    await this.prisma.invoiceRequest.updateMany({
      where: { id: row.id, leaseToken: row.leaseToken, leaseUntil: { gt: new Date() } },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + retryDelay(row.attempts + 1)),
        leaseToken: null,
        leaseUntil: null,
      },
    });
  }

  /**
   * The bytes exactly as signed; nothing else is ever sent. A file that cannot be read is retried,
   * since storage drivers do not tell a missing file from an outage. Only altered bytes (SHA-256
   * mismatch) halt the row until someone intervenes.
   */
  private async signedBytes(row: InvoiceRequest): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = this.crypto.decryptBuffer(
        row.tenantId,
        await this.storage.get(row.signedXmlStorageKey!),
      );
    } catch {
      throw new SriError('transient', 'INVOICE_SIGNED_XML_UNAVAILABLE');
    }
    if (createHash('sha256').update(bytes).digest('hex') !== row.signedXmlSha256)
      throw new SriError('configuration', 'INVOICE_SIGNED_XML_INTEGRITY');
    return bytes;
  }

  private snapshot(row: InvoiceRequest): FiscalSnapshot {
    return JSON.parse(this.crypto.decrypt(row.tenantId, row.snapshotEncrypted)) as FiscalSnapshot;
  }

  /** Step a: everything that must hold before a sequential is spent. */
  private async preflight(row: InvoiceRequest, s: FiscalSnapshot): Promise<SigningMaterial> {
    const issuer = row.issuerId
      ? await this.prisma.invoicingIssuer.findUnique({ where: { id: row.issuerId } })
      : null;
    if (!issuer || issuer.tenantId !== row.tenantId || !issuer.active)
      throw new SriError('configuration', 'INVOICING_NOT_CONFIGURED');
    if (issuer.environment !== s.environment)
      throw new SriError('configuration', 'INVOICING_ENVIRONMENT_CHANGED');
    const point = await this.prisma.branchEmissionPoint.findFirst({
      where: {
        issuerId: issuer.id,
        establishmentCode: s.establishmentCode,
        emissionPointCode: s.emissionPointCode,
      },
      select: { id: true },
    });
    if (!point) throw new SriError('configuration', 'INVOICING_NOT_CONFIGURED');
    const material = this.issuers.loadSigningMaterial(issuer);
    assertCertificateFor(material, s.issuer.ruc);
    return material;
  }

  /**
   * Step b: reserve the sequential, sign, verify and store, all under the lease. Returns the signed
   * row, or null when the lease was lost.
   */
  private async sign(row: InvoiceRequest): Promise<InvoiceRequest | null> {
    const s = this.snapshot(row);
    const material = await this.preflight(row, s);
    const stored: { key?: string } = {};
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const sequential = await this.reserveSequential(tx, row.issuerId!, s);
          const accessKey = buildAccessKey({
            issueDate: s.issueDate,
            ruc: s.issuer.ruc,
            environment: s.environment,
            establishmentCode: s.establishmentCode,
            emissionPointCode: s.emissionPointCode,
            sequential,
            numericCode: newNumericCode(),
          });
          const doc = toInvoiceDocument(s, sequential, accessKey);
          const xml = signInvoiceXml(buildInvoiceXml(doc), material, new Date());
          const check = verifyInvoiceSignature(xml);
          if (!check.valid || check.certificateSha256 !== material.sha256)
            throw new SriError('configuration', 'INVOICE_SIGNATURE_INVALID');
          const bytes = Buffer.from(xml, 'utf8');
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const number = invoiceNumber(doc);
          const key = `invoices/${row.tenantId}/${row.id}/signed-${randomUUID()}`;
          stored.key = key;
          await this.storage.put(key, this.crypto.encryptBuffer(row.tenantId, bytes));
          const data = {
            status: 'PROCESSING' as const,
            externalState: 'SIGNED',
            sequential: String(sequential).padStart(9, '0'),
            accessKey,
            number,
            signedXmlStorageKey: key,
            signedXmlSha256: sha256,
            lastErrorEncrypted: null,
          };
          const changed = await tx.invoiceRequest.updateMany({
            where: {
              id: row.id,
              leaseToken: row.leaseToken,
              leaseUntil: { gt: new Date() },
              signedXmlStorageKey: null,
            },
            data,
          });
          if (!changed.count) throw new LeaseLost();
          await tx.invoiceRequestEvent.create({
            data: {
              issuerId: row.issuerId,
              connectionId: null,
              invoiceRequestId: row.id,
              type: 'SIGNED',
              source: 'DISPATCHER',
              detail: { number, sha256 },
            },
          });
          return { ...row, ...data };
        },
        { timeout: 20000 },
      );
    } catch (error) {
      if (stored.key && (error instanceof LeaseLost || !(await this.referenced(row, stored.key))))
        await this.storage.remove(stored.key).catch(() => undefined);
      if (error instanceof LeaseLost) return null;
      throw error;
    }
  }

  /**
   * A failed COMMIT may still have committed. The file is kept unless the row provably does not
   * point at it: an orphaned encrypted file is harmless, a signed row without its XML is stuck.
   */
  private async referenced(row: InvoiceRequest, key: string): Promise<boolean> {
    try {
      return !!(await this.prisma.invoiceRequest.findFirst({
        where: { id: row.id, signedXmlStorageKey: key },
        select: { id: true },
      }));
    } catch {
      return true;
    }
  }

  /** Gaps left by rolled-back or rejected requests are acceptable to the SRI. */
  private async reserveSequential(
    tx: Prisma.TransactionClient,
    issuerId: string,
    s: FiscalSnapshot,
  ): Promise<number> {
    const reserved = await tx.$queryRaw<{ sequential: number }[]>`
      UPDATE "InvoiceSequence" SET "next" = "next" + 1
      WHERE "issuerId" = ${issuerId} AND "establishmentCode" = ${s.establishmentCode}
        AND "emissionPointCode" = ${s.emissionPointCode} AND "environment" = ${s.environment}
      RETURNING "next" - 1 AS "sequential"`;
    if (reserved.length) return Number(reserved[0].sequential);
    await tx.invoiceSequence.create({
      data: {
        issuerId,
        establishmentCode: s.establishmentCode,
        emissionPointCode: s.emissionPointCode,
        environment: s.environment,
        next: 2,
      },
    });
    return 1;
  }
}
