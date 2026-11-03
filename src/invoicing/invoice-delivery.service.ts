import { Inject, Injectable } from '@nestjs/common';
import { InvoiceRequest } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { MailService } from '../mail/mail.service';
import { invoiceMail } from '../mail/mail.templates';
import { FiscalSnapshot } from './invoice-snapshot';
import { retryDelay } from './invoice-state';

/** After this many attempts, or a skip, the reconcile claim stops picking the row for its e-mail. */
export const MAX_EMAIL_ATTEMPTS = 5;

/** Step f: e-mails the authorized XML and the RIDE to the billing customer, once. */
@Injectable()
export class InvoiceDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly mail: MailService,
  ) {}

  /** Runs under the lease; the stored row, not the claimed one, says what is still pending. */
  async deliver(row: InvoiceRequest): Promise<void> {
    if (!row.leaseToken) return;
    const current = await this.prisma.invoiceRequest.findFirst({
      where: {
        id: row.id,
        status: 'AUTHORIZED',
        leaseToken: row.leaseToken,
        leaseUntil: { gt: new Date() },
      },
    });
    if (
      !current ||
      current.emailedAt ||
      current.emailAttempts >= MAX_EMAIL_ATTEMPTS ||
      !current.xmlStorageKey ||
      !current.rideStorageKey
    )
      return;
    let sent = false;
    try {
      const snapshot = JSON.parse(
        this.crypto.decrypt(current.tenantId, current.snapshotEncrypted),
      ) as FiscalSnapshot;
      const to = snapshot.customer.email?.trim();
      // No address (final consumer): nothing to send, and the row must not be claimed for it again.
      if (!to)
        return await this.record(current, 'EMAIL_SKIPPED', { emailAttempts: MAX_EMAIL_ATTEMPTS });
      const number = current.number!;
      const content = invoiceMail({
        number,
        issuerName: snapshot.issuer.tradeName ?? snapshot.issuer.legalName,
        customerName: snapshot.customer.name,
        authorizedAt: current.authorizedAt!,
      });
      content.attachments = [
        {
          filename: `factura-${number}.xml`,
          content: await this.file(current, current.xmlStorageKey, current.xmlSha256),
          contentType: 'application/xml',
        },
        {
          filename: `factura-${number}.pdf`,
          content: await this.file(current, current.rideStorageKey, current.rideSha256),
          contentType: 'application/pdf',
        },
      ];
      sent = await this.mail.send(to, content);
    } catch {
      /* An unreadable snapshot or file counts as a failed attempt, like a refused send. */
    }
    if (sent) return this.record(current, 'EMAILED', { emailedAt: new Date() });
    await this.record(
      current,
      'EMAIL_FAILED',
      {
        emailAttempts: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + retryDelay(current.emailAttempts + 1)),
      },
      { attempt: current.emailAttempts + 1 },
    );
  }

  private async file(row: InvoiceRequest, key: string, sha256: string | null): Promise<Buffer> {
    const bytes = this.crypto.decryptBuffer(row.tenantId, await this.storage.get(key));
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('integrity');
    return bytes;
  }

  /** One CAS under the lease and its event. The address never goes into an event. */
  private async record(
    row: InvoiceRequest,
    type: 'EMAILED' | 'EMAIL_SKIPPED' | 'EMAIL_FAILED',
    data: Record<string, unknown>,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.invoiceRequest.updateMany({
        where: {
          id: row.id,
          status: 'AUTHORIZED',
          leaseToken: row.leaseToken,
          leaseUntil: { gt: new Date() },
          emailedAt: null,
        },
        data,
      });
      if (!changed.count) return;
      await tx.invoiceRequestEvent.create({
        data: {
          issuerId: row.issuerId,
          invoiceRequestId: row.id,
          type,
          source: 'DISPATCHER',
          detail: detail as object,
        },
      });
    });
  }
}
