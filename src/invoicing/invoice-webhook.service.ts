import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { EmiteFacilProvider } from './provider/emite-facil.provider';
import { verifyWebhookSignature, WebhookHeaders } from './provider/webhook-signature';
import { InvoiceWorkerService } from './invoice-worker.service';
import { invoiceError } from './invoice-errors';
@Injectable()
export class InvoiceWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    private readonly provider: EmiteFacilProvider,
    private readonly worker: InvoiceWorkerService,
  ) {}
  async receive(connectionId: string, raw: Buffer, headers: WebhookHeaders) {
    const c = await this.prisma.invoicingConnection.findUnique({ where: { id: connectionId } });
    if (
      !c?.webhookSecretEncrypted ||
      !verifyWebhookSignature(
        raw,
        headers,
        this.crypto.decrypt(c.tenantId, c.webhookSecretEncrypted),
      )
    )
      throw new UnauthorizedException();
    let event: any;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new UnauthorizedException();
    }
    if (
      !event ||
      event.tenantId !== c.externalTenantId ||
      event.eventId !== headers['webhook-id'] ||
      typeof event.eventType !== 'string'
    )
      throw new UnauthorizedException();
    if (
      await this.prisma.invoiceRequestEvent.findUnique({
        where: { connectionId_webhookEventId: { connectionId, webhookEventId: event.eventId } },
      })
    )
      return;
    const row =
      typeof event.document?.id === 'string'
        ? await this.prisma.invoiceRequest.findFirst({
            where: { connectionId, tenantId: c.tenantId, externalDocumentId: event.document.id },
          })
        : null;
    try {
      if (!row) {
        await this.prisma.invoiceRequestEvent.create({
          data: {
            connectionId,
            webhookEventId: event.eventId,
            type: 'WEBHOOK_IGNORED',
            source: 'WEBHOOK',
            detail: {},
          },
        });
        return;
      }
      const client = this.provider.client(
        this.crypto.decrypt(c.tenantId, c.apiKeyEncrypted),
        row.id,
      );
      // Fetch authoritative state: late or forged document fields never regress local state.
      const doc = await client.getDocument(row.externalDocumentId!);
      let reason: unknown;
      if (['RETURNED', 'NOT_AUTHORIZED', 'XSD_INVALID', 'SIGNATURE_FAILED'].includes(doc.state)) {
        try {
          reason = await client.getSriAttempts(doc.id);
        } catch {}
      }
      await this.worker.applyDocument(row.id, doc, 'WEBHOOK', event.eventId, undefined, reason);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return;
      throw invoiceError('INVOICING_WEBHOOK_RETRY', 503);
    }
  }
}
