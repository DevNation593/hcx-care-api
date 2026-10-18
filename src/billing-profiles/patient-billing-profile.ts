import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { validateSync } from 'class-validator';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { CreateBillingProfileDto } from './dto/billing-profile.dto';
import { assertValidTaxIdentification, normalizeIdNumber, SriIdType } from './tax-identification';

const PATIENT_ID_TYPES: Record<string, SriIdType | undefined> = {
  CEDULA: '05',
  RUC: '04',
  PASSPORT: '06',
};

/** Uses registered fiscal data only when it can form a valid invoice recipient. */
export async function patientBillingProfileId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorId: string,
  patientId: string,
): Promise<string | null> {
  const patient = await tx.patient.findFirst({
    where: { id: patientId, tenantId, deletedAt: null },
    select: {
      firstName: true,
      lastName: true,
      identificationType: true,
      identificationNumber: true,
      email: true,
      address: true,
      phone: true,
      billingName: true,
      billingTaxIdType: true,
      billingTaxId: true,
      billingEmail: true,
      billingAddress: true,
    },
  });
  if (!patient) return null;

  // Keep a separately registered fiscal identity together instead of mixing it with the patient's name.
  const hasFiscalIdentity = Boolean(patient.billingTaxId?.trim());
  const rawIdType = hasFiscalIdentity ? patient.billingTaxIdType : patient.identificationType;
  const idType = PATIENT_ID_TYPES[rawIdType?.trim().toUpperCase() ?? ''];
  if (!idType) return null;
  const idNumber = normalizeIdNumber(
    idType,
    (hasFiscalIdentity ? patient.billingTaxId : patient.identificationNumber) ?? '',
  );
  const legalName = hasFiscalIdentity
    ? (patient.billingName?.trim() ?? '')
    : [patient.firstName.trim(), patient.lastName.trim()].filter(Boolean).join(' ');
  try {
    assertValidTaxIdentification(idType, idNumber, legalName);
  } catch (error) {
    if (error instanceof UnprocessableEntityException) return null;
    throw error;
  }

  const existing = await tx.billingProfile.findFirst({ where: { tenantId, idType, idNumber } });
  if (existing && !existing.isActive) return null;

  let profile = existing;
  if (!profile) {
    const data = Object.assign(new CreateBillingProfileDto(), {
      kind: idType === '04' && ['6', '9'].includes(idNumber[2]) ? 'COMPANY' : 'PERSON',
      idType,
      idNumber,
      legalName,
      email:
        ((hasFiscalIdentity ? patient.billingEmail : null) || patient.email)?.trim() || undefined,
      address:
        ((hasFiscalIdentity ? patient.billingAddress : null) || patient.address)?.trim() ||
        undefined,
      phone: patient.phone?.trim() || undefined,
    });
    // Apply the same requirements as manual creation; incomplete data leaves the order selectable.
    if (validateSync(data).length > 0) return null;

    profile = await tx.billingProfile.upsert({
      where: { tenantId_idType_idNumber: { tenantId, idType, idNumber } },
      update: {},
      create: {
        tenantId,
        ...data,
        email: data.email ?? null,
        address: data.address ?? null,
        phone: data.phone ?? null,
        createdById: actorId,
      },
    });
    if (!profile.isActive) return null;
    await recordBillingAudit(tx, {
      tenantId,
      actorId,
      action: 'CREATE',
      entity: 'BILLING_PROFILE',
      entityId: profile.id,
      changes: { after: { kind: profile.kind, idType, legalName }, source: 'PATIENT_DATA' },
    });
  }

  // Preserve any configured default, including a third-party receiver or an inactive profile.
  await tx.patientBillingProfile.upsert({
    where: { patientId_billingProfileId: { patientId, billingProfileId: profile.id } },
    update: {},
    create: { tenantId, patientId, billingProfileId: profile.id },
  });
  await recordBillingAudit(tx, {
    tenantId,
    actorId,
    action: 'UPDATE',
    entity: 'BILLING_PROFILE',
    entityId: profile.id,
    changes: { linkedPatientId: patientId, source: 'PATIENT_DATA' },
  });
  return profile.id;
}
