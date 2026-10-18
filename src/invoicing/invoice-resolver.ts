import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, InvoiceRequest } from '@prisma/client';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { FiscalSnapshot } from './invoice-snapshot';
import { InvoicingProvider, InvoiceBody, ProviderError } from './provider/invoicing-provider';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
@Injectable()
export class InvoiceResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
  ) {}
  async resolve(row: InvoiceRequest, client: InvoicingProvider): Promise<InvoiceBody> {
    await this.assertLease(row);
    const s = JSON.parse(
      this.crypto.decrypt(row.tenantId, row.snapshotEncrypted),
    ) as FiscalSnapshot;
    const taxpayer = (await client.listTaxpayers()).find((t) => t.id === s.taxpayerId);
    if (!taxpayer || taxpayer.defaultEnvironment !== s.environment)
      throw new ProviderError('configuration', 'INVOICING_ENVIRONMENT_CHANGED');
    const establishments = await client.listEstablishments(s.taxpayerId);
    const establishment = establishments.find(
      (e) => e.taxpayerId === s.taxpayerId && e.code === s.establishmentCode,
    );
    if (
      !establishment ||
      !(await client.listEmissionPoints(s.taxpayerId, establishment.id)).some(
        (p) =>
          p.establishmentId === establishment.id && p.code === s.emissionPointCode && p.enabled,
      )
    )
      throw new ProviderError('configuration', 'INVOICING_POINT_INVALID');
    let customer = await client.findCustomer(s.customer.idType, s.customer.idNumber);
    if (!customer) {
      try {
        await this.assertLease(row);
        customer = await client.createCustomer(s.customer);
      } catch (e) {
        if (!(e instanceof ProviderError) || e.code !== 'CUSTOMER_ALREADY_EXISTS') throw e;
        customer = await client.findCustomer(s.customer.idType, s.customer.idNumber);
      }
    }
    if (!customer) throw new ProviderError('transient', 'CUSTOMER_SYNC_PENDING');
    const normal = (v: unknown) => (typeof v === 'string' ? v.trim() || null : null);
    if (
      ['idType', 'idNumber', 'name', 'email', 'address', 'phone'].some(
        (k) =>
          normal(customer![k as keyof typeof customer]) !==
          normal(s.customer[k as keyof typeof s.customer]),
      )
    )
      throw new ProviderError('data', 'CUSTOMER_SYNC_REQUIRED');
    await this.ref(row, 'CUSTOMER', row.billingProfileId, customer.id, hash(s.customer));
    const rates = await client.listTaxRates();
    const lines: InvoiceBody['lines'] = [];
    for (const l of s.lines) {
      const rate = rates.find(
        (r) => r.taxCode === '2' && new Prisma.Decimal(r.rate).equals(l.taxRatePercent),
      );
      if (!rate) throw new ProviderError('data', 'TAX_RATE_UNSUPPORTED');
      const definition = { name: l.name, unitPrice: l.unitPrice, ivaRateCode: rate.rateCode };
      const sku = 'HCX.' + hash({ localId: l.localId, ...definition }).slice(0, 21);
      let product = await client.findProduct(sku);
      if (!product) {
        try {
          await this.assertLease(row);
          product = await client.createProduct({ sku, ...definition });
        } catch (e) {
          if (!(e instanceof ProviderError) || e.code !== 'PRODUCT_SKU_TAKEN') throw e;
          product = await client.findProduct(sku);
        }
      }
      if (!product) throw new ProviderError('transient', 'PRODUCT_SYNC_PENDING');
      if (product.name !== l.name || product.ivaRateCode !== rate.rateCode)
        throw new ProviderError('data', 'PRODUCT_SYNC_REQUIRED');
      await this.ref(row, 'PRODUCT', l.localId, product.id, hash(definition));
      lines.push({
        productId: product.id,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount,
      });
    }
    return {
      taxpayerId: s.taxpayerId,
      establishmentCode: s.establishmentCode,
      emissionPointCode: s.emissionPointCode,
      customerId: customer.id,
      issueDate: s.issueDate,
      currency: 'USD',
      lines,
      payments: s.payments,
      ...(s.replacesDocumentId ? { replacesDocumentId: s.replacesDocumentId } : {}),
    };
  }
  private lease(row: InvoiceRequest) {
    return { id: row.id, leaseToken: row.leaseToken, leaseUntil: { gt: new Date() } };
  }
  private async assertLease(row: InvoiceRequest) {
    if (
      !row.leaseToken ||
      !(await this.prisma.invoiceRequest.findFirst({
        where: this.lease(row),
        select: { id: true },
      }))
    )
      throw new ProviderError('configuration', 'INVOICING_LEASE_LOST');
  }
  private async ref(
    row: InvoiceRequest,
    kind: string,
    localId: string,
    externalId: string,
    syncedHash: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (
        !row.leaseToken ||
        !(
          await tx.invoiceRequest.updateMany({
            where: this.lease(row),
            data: { leaseUntil: new Date(Date.now() + 120000) },
          })
        ).count
      )
        throw new ProviderError('configuration', 'INVOICING_LEASE_LOST');
      await tx.invoicingRef.upsert({
        where: { connectionId_kind_localId: { connectionId: row.connectionId, kind, localId } },
        create: { connectionId: row.connectionId, kind, localId, externalId, syncedHash },
        update: { externalId, syncedHash },
      });
    });
  }
}
