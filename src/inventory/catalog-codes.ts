import { Prisma } from '@prisma/client';

/** Treatments and products share one code space on the invoice. */
export const normalizeCatalogCode = (code: string): string => code.trim().toUpperCase();

export async function isCodeUsedByTreatment(
  tx: Pick<Prisma.TransactionClient, 'treatment'>,
  tenantId: string,
  code: string,
  exceptTreatmentId?: string,
): Promise<boolean> {
  const found = await tx.treatment.findFirst({
    where: {
      tenantId,
      code: normalizeCatalogCode(code),
      ...(exceptTreatmentId ? { id: { not: exceptTreatmentId } } : {}),
    },
    select: { id: true },
  });
  return found != null;
}

export async function isCodeUsedByProduct(
  tx: Pick<Prisma.TransactionClient, 'product'>,
  tenantId: string,
  code: string,
  exceptProductId?: string,
): Promise<boolean> {
  const found = await tx.product.findFirst({
    where: {
      tenantId,
      code: normalizeCatalogCode(code),
      ...(exceptProductId ? { id: { not: exceptProductId } } : {}),
    },
    select: { id: true },
  });
  return found != null;
}
