import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const invoiceInclude = {
  issuer: { select: { id: true, firstName: true, lastName: true, role: true } },
  patient: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  listInvoices(tenantId: string, filters: { patientId?: string } = {}) {
    const patientId = filters.patientId?.trim();
    return this.prisma.invoice.findMany({
      where: { tenantId, ...(patientId && { patientId }) },
      include: invoiceInclude,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getInvoice(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: invoiceInclude,
    });
    if (!invoice) {
      throw new NotFoundException('Comprobante no encontrado');
    }
    return invoice;
  }
}
