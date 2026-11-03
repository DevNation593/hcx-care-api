import { Inject, Injectable } from '@nestjs/common';
import { InvoiceRequest, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { IssuerService } from './issuer.service';
import { FiscalSnapshot, toInvoiceDocument } from './invoice-snapshot';
import { buildAccessKey, newNumericCode } from './sri/access-key';
import { assertCertificateFor, SigningMaterial } from './sri/certificate';
import { buildInvoiceXml, invoiceNumber } from './sri/invoice-xml';
import { SriError } from './sri/sri-types';
import { signInvoiceXml } from './sri/xades-signer';
import { verifyInvoiceSignature } from './sri/xades-verifier';

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
  ) {}

  /** Throws SriError; a configuration error before signing fails the request safely. */
  async advance(row: InvoiceRequest, deadline: number): Promise<void> {
    // Signed XML is final: the request never gets another sequential or access key.
    if (row.signedXmlStorageKey || Date.now() >= deadline) return;
    await this.sign(row);
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

  /** Step b: reserve the sequential, sign, verify and store, all under the lease. */
  private async sign(row: InvoiceRequest): Promise<void> {
    const s = JSON.parse(
      this.crypto.decrypt(row.tenantId, row.snapshotEncrypted),
    ) as FiscalSnapshot;
    const material = await this.preflight(row, s);
    const stored: { key?: string } = {};
    try {
      await this.prisma.$transaction(
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
          stored.key = `invoices/${row.tenantId}/${row.id}/signed-${randomUUID()}`;
          await this.storage.put(stored.key, this.crypto.encryptBuffer(row.tenantId, bytes));
          const changed = await tx.invoiceRequest.updateMany({
            where: {
              id: row.id,
              leaseToken: row.leaseToken,
              leaseUntil: { gt: new Date() },
              signedXmlStorageKey: null,
            },
            data: {
              status: 'PROCESSING',
              externalState: 'SIGNED',
              sequential: String(sequential).padStart(9, '0'),
              accessKey,
              number,
              signedXmlStorageKey: stored.key,
              signedXmlSha256: sha256,
              lastErrorEncrypted: null,
            },
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
        },
        { timeout: 20000 },
      );
    } catch (error) {
      if (stored.key) await this.storage.remove(stored.key).catch(() => undefined);
      if (error instanceof LeaseLost) return;
      throw error;
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
