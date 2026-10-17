import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { InvoiceRequest } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { InvoicingProvider } from './provider/invoicing-provider';
import { invoiceError } from './invoice-errors';
@Injectable()
export class InvoiceArtifactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}
  async collect(row: InvoiceRequest, client: InvoicingProvider) {
    if (row.status !== 'AUTHORIZED' || !row.externalDocumentId) return;
    for (const kind of ['xml', 'ride'] as const) {
      const keyField = kind === 'xml' ? 'xmlStorageKey' : 'rideStorageKey';
      const hashField = kind === 'xml' ? 'xmlSha256' : 'rideSha256';
      if (row[keyField]) continue;
      try {
        if (!(await this.ownsLease(row))) return;
        if (!this.crypto.enabled) throw invoiceError('INVOICING_ENCRYPTION_REQUIRED', 503);
        const artifact = await client.getArtifact(
          row.externalDocumentId,
          kind === 'xml' ? 'xml-authorized' : 'ride',
        );
        if (createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.sha256)
          throw invoiceError('INVOICE_ARTIFACT_INTEGRITY', 503);
        if (!(await this.ownsLease(row))) return;
        const key = `invoices/${row.tenantId}/${row.id}/${kind}-${randomUUID()}`;
        await this.storage.put(key, this.crypto.encryptBuffer(row.tenantId, artifact.bytes));
        const kept = await this.prisma.$transaction(async (tx) => {
          const changed = await tx.invoiceRequest.updateMany({
            where: {
              id: row.id,
              status: 'AUTHORIZED',
              leaseToken: row.leaseToken,
              leaseUntil: { gt: new Date() },
              [keyField]: null,
            },
            data: { [keyField]: key, [hashField]: artifact.sha256 },
          });
          if (changed.count)
            await tx.invoiceRequestEvent.create({
              data: {
                connectionId: row.connectionId,
                invoiceRequestId: row.id,
                type: 'ARTIFACT_STORED',
                source: 'RECONCILER',
                detail: { kind, sha256: artifact.sha256 },
              },
            });
          return changed.count;
        });
        if (!kept) await this.storage.remove(key);
      } catch {
        /* Authorization survives artifact unavailability; the reconciler retries. */
      }
    }
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
