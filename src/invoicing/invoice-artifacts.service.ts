import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { InvoiceRequest } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { invoiceError } from './invoice-errors';
import { FiscalSnapshot, toInvoiceDocument } from './invoice-snapshot';
import { buildAuthorizedXml } from './sri/authorized-xml';
import { renderRide } from './sri/ride';
import { SriError } from './sri/sri-types';

const ENVIRONMENT_LABELS = { '1': 'PRUEBAS', '2': 'PRODUCCIÓN' } as const;

function failureCode(error: unknown): string {
  if (error instanceof SriError) return error.code;
  if (error instanceof HttpException) {
    const code = (error.getResponse() as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'INVOICING_INTERNAL_ERROR';
}

@Injectable()
export class InvoiceArtifactsService {
  private readonly logger = new Logger(InvoiceArtifactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /**
   * Step e: keeps the authorized XML and the RIDE, built from the stored signed XML and the
   * snapshot. Each file has its own CAS under the lease; a failure leaves the authorization alone
   * and the next pass retries what is missing.
   */
  async collect(row: InvoiceRequest): Promise<void> {
    if (row.status !== 'AUTHORIZED') return;
    let built: { signedXml: string; snapshot: FiscalSnapshot } | undefined;
    for (const kind of ['xml', 'ride'] as const) {
      const keyField = kind === 'xml' ? 'xmlStorageKey' : 'rideStorageKey';
      const hashField = kind === 'xml' ? 'xmlSha256' : 'rideSha256';
      if (row[keyField]) continue;
      try {
        if (!(await this.ownsLease(row))) return;
        if (!this.crypto.enabled) throw invoiceError('INVOICING_ENCRYPTION_REQUIRED', 503);
        built ??= await this.sources(row);
        const bytes =
          kind === 'xml'
            ? Buffer.from(this.authorizedXml(row, built), 'utf8')
            : await this.ride(row, built);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (!(await this.ownsLease(row))) return;
        const key = `invoices/${row.tenantId}/${row.id}/${kind}-${randomUUID()}`;
        await this.storage.put(key, this.crypto.encryptBuffer(row.tenantId, bytes));
        const kept = await this.prisma.$transaction(async (tx) => {
          const changed = await tx.invoiceRequest.updateMany({
            where: {
              id: row.id,
              status: 'AUTHORIZED',
              leaseToken: row.leaseToken,
              leaseUntil: { gt: new Date() },
              [keyField]: null,
            },
            data: { [keyField]: key, [hashField]: sha256 },
          });
          if (changed.count)
            await tx.invoiceRequestEvent.create({
              data: {
                issuerId: row.issuerId,
                connectionId: null,
                invoiceRequestId: row.id,
                type: 'ARTIFACT_STORED',
                source: 'DISPATCHER',
                detail: { kind, sha256 },
              },
            });
          return changed.count;
        });
        if (!kept) await this.storage.remove(key);
      } catch (error) {
        // The authorization survives; the next pass retries. Only the failure code is traced.
        await this.traceFailure(row, kind, error);
      }
    }
  }

  private async traceFailure(row: InvoiceRequest, kind: 'xml' | 'ride', error: unknown) {
    const code = failureCode(error);
    this.logger.warn(`Invoice ${row.id}: ${kind} artifact failed (${code})`);
    try {
      await this.prisma.invoiceRequestEvent.create({
        data: {
          issuerId: row.issuerId,
          connectionId: null,
          invoiceRequestId: row.id,
          type: 'ARTIFACT_FAILED',
          source: 'DISPATCHER',
          detail: { kind, code },
        },
      });
    } catch {
      /* Tracing must never break the pass. */
    }
  }

  /** The signed bytes, SHA-256 checked, and the decrypted snapshot. */
  private async sources(row: InvoiceRequest) {
    const bytes = this.crypto.decryptBuffer(
      row.tenantId,
      await this.storage.get(row.signedXmlStorageKey!),
    );
    if (createHash('sha256').update(bytes).digest('hex') !== row.signedXmlSha256)
      throw invoiceError('INVOICE_SIGNED_XML_INTEGRITY', 503);
    return {
      signedXml: bytes.toString('utf8'),
      snapshot: JSON.parse(
        this.crypto.decrypt(row.tenantId, row.snapshotEncrypted),
      ) as FiscalSnapshot,
    };
  }

  private authorizedXml(
    row: InvoiceRequest,
    { signedXml, snapshot }: { signedXml: string; snapshot: FiscalSnapshot },
  ): string {
    return buildAuthorizedXml({
      signedXml,
      authorizationNumber: row.authorizationNumber!,
      authorizedAt: row.authorizedAt!,
      environmentLabel: ENVIRONMENT_LABELS[snapshot.environment],
    });
  }

  private ride(row: InvoiceRequest, { snapshot }: { snapshot: FiscalSnapshot }): Promise<Buffer> {
    return renderRide({
      document: toInvoiceDocument(snapshot, Number(row.sequential), row.accessKey!),
      authorizationNumber: row.authorizationNumber!,
      authorizedAt: row.authorizedAt!,
    });
  }

  private async ownsLease(row: InvoiceRequest) {
    return (
      !!row.leaseToken &&
      !!(await this.prisma.invoiceRequest.findFirst({
        where: {
          id: row.id,
          status: 'AUTHORIZED',
          leaseToken: row.leaseToken,
          leaseUntil: { gt: new Date() },
        },
        select: { id: true },
      }))
    );
  }

  async read(tenantId: string, userId: string, id: string, kind: 'xml' | 'ride') {
    const r = await this.prisma.invoiceRequest.findFirst({ where: { id, tenantId } });
    if (!r) throw invoiceError('INVOICE_REQUEST_NOT_FOUND', 404);
    const key = kind === 'xml' ? r.xmlStorageKey : r.rideStorageKey;
    const digest = kind === 'xml' ? r.xmlSha256 : r.rideSha256;
    if (r.status !== 'AUTHORIZED' || !key || !digest)
      throw invoiceError('INVOICE_ARTIFACT_NOT_READY', 404);
    let bytes: Buffer;
    try {
      bytes = this.crypto.decryptBuffer(tenantId, await this.storage.get(key));
      if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('integrity');
    } catch {
      throw invoiceError('INVOICE_ARTIFACT_INTEGRITY', 503);
    }
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        entity: 'INVOICE_REQUEST',
        entityId: id,
        action: 'READ',
        changes: { artifact: kind, sha256: digest },
      },
    });
    return {
      bytes,
      sha256: digest,
      contentType: kind === 'xml' ? 'application/xml' : 'application/pdf',
      filename: `factura-${r.number ?? id}.${kind === 'xml' ? 'xml' : 'pdf'}`,
    };
  }
}
