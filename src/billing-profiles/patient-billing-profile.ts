import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { validateSync } from 'class-validator';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { CreateBillingProfileDto } from './dto/billing-profile.dto';
import { assertValidTaxIdentification, normalizeIdNumber, SriIdType } from './tax-identification';

export const PATIENT_ID_TYPES: Record<string, SriIdType | undefined> = {
  CEDULA: '05',
  RUC: '04',
  PASSPORT: '06',
};

/** Patient columns an invoice recipient is built from. */
export const PATIENT_BILLING_SELECT = {
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
} satisfies Prisma.PatientSelect;

export type PatientBillingSource = Prisma.PatientGetPayload<{
  select: typeof PATIENT_BILLING_SELECT;
}>;

/** A patient datum that keeps the record from being its own invoice recipient. */
export type PatientBillingIssue = 'identification' | 'legalName' | 'email' | 'address' | 'phone';

// Every CreateBillingProfileDto property maps to the patient datum it comes from.
const ISSUE_OF_PROPERTY: Record<string, PatientBillingIssue> = {
  kind: 'identification',
  idType: 'identification',
  idNumber: 'identification',
  legalName: 'legalName',
  email: 'email',
  address: 'address',
  phone: 'phone',
};

/**
 * The recipient the patient record forms, with the same requirements as manual creation, and
 * what in the record stops it from being valid. A separately registered fiscal identity is kept
 * together instead of being mixed with the patient's name.
 */
export function patientBillingDraft(patient: PatientBillingSource): {
  data: CreateBillingProfileDto;
  issues: PatientBillingIssue[];
} {
  const fiscal = Boolean(patient.billingTaxId?.trim());
  const rawIdType = fiscal ? patient.billingTaxIdType : patient.identificationType;
  const idType = PATIENT_ID_TYPES[rawIdType?.trim().toUpperCase() ?? ''];
  const rawNumber = (fiscal ? patient.billingTaxId : patient.identificationNumber) ?? '';
  const idNumber = idType ? normalizeIdNumber(idType, rawNumber) : rawNumber.trim();
  const legalName = fiscal
    ? (patient.billingName?.trim() ?? '')
    : [patient.firstName.trim(), patient.lastName.trim()].filter(Boolean).join(' ');

  const data = Object.assign(new CreateBillingProfileDto(), {
    kind: idType === '04' && ['6', '9'].includes(idNumber[2]) ? 'COMPANY' : 'PERSON',
    idType,
    idNumber,
    legalName,
    email: ((fiscal ? patient.billingEmail : null) || patient.email)?.trim() || undefined,
    address: ((fiscal ? patient.billingAddress : null) || patient.address)?.trim() || undefined,
    phone: patient.phone?.trim() || undefined,
  });

  const issues = new Set(validateSync(data).map((error) => ISSUE_OF_PROPERTY[error.property]));
  try {
    if (idType) assertValidTaxIdentification(idType, idNumber, legalName);
  } catch (error) {
    if (!(error instanceof UnprocessableEntityException)) throw error;
    issues.add('identification');
  }
  return { data, issues: [...issues] };
}

/** Uses registered fiscal data only when it can form a valid invoice recipient. */
export async function patientBillingProfileId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorId: string,
  patientId: string,
): Promise<string | null> {
  const patient = await tx.patient.findFirst({
    where: { id: patientId, tenantId, deletedAt: null },
    select: PATIENT_BILLING_SELECT,
  });
  if (!patient) return null;

  const { data, issues } = patientBillingDraft(patient);
  if (issues.includes('identification')) return null;
  const { idType, idNumber, legalName } = data;

  const existing = await tx.billingProfile.findFirst({ where: { tenantId, idType, idNumber } });
  if (existing && !existing.isActive) return null;

  let profile = existing;
  if (!profile) {
    // Incomplete data leaves the order selectable; an existing profile is reused as it is.
    if (issues.length > 0) return null;

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
