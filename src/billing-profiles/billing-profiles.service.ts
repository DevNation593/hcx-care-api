import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BillingProfile, Prisma } from '@prisma/client';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { mergePatientIdentification } from '../patients/patient-identity';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import {
  BillAsPatientDto,
  CreateBillingProfileDto,
  LinkBillingProfileDto,
  ListBillingProfilesQuery,
  UpdateBillingProfileDto,
} from './dto/billing-profile.dto';
import { assertSectionInEffect } from '../common/sections/section-in-effect';
import {
  PATIENT_BILLING_SELECT,
  PATIENT_ID_TYPES,
  patientBillingDraft,
  patientBillingProfileId,
  type PatientBillingIssue,
  type PatientBillingSource,
} from './patient-billing-profile';
import {
  assertValidTaxIdentification,
  FINAL_CONSUMER_NAME,
  normalizeIdNumber,
  type SriIdType,
} from './tax-identification';

export type LinkedBillingProfile = BillingProfile & { isDefault: boolean };

/** Patient columns an invoice in the patient's name may complete. */
type PatientFill = Partial<
  Record<'identificationType' | 'identificationNumber' | 'email' | 'address' | 'phone', string>
>;

const blank = (value: string | null | undefined) => !value?.trim();

const OWN = { ownIdentity: true } as const;

const ISSUE_LABELS: Record<PatientBillingIssue, string> = {
  identification: 'la identificación',
  legalName: 'el nombre',
  email: 'el correo',
  address: 'la dirección',
  phone: 'el teléfono',
};

/**
 * 422 naming what keeps the record from being its own recipient: `missing` are empty data that
 * the request may complete; `invalid` are data on file that must be fixed in the record.
 */
function patientBillingDataIncomplete(draft: ReturnType<typeof patientBillingDraft>) {
  const empty = (issue: PatientBillingIssue) =>
    (issue === 'identification' && blank(draft.data.idNumber)) ||
    (issue === 'email' && blank(draft.data.email));
  const missing = draft.issues.filter(empty);
  const invalid = draft.issues.filter((issue) => !empty(issue));
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'PATIENT_BILLING_DATA_INCOMPLETE',
    message:
      invalid.length > 0
        ? `Corrige en la ficha ${invalid.map((issue) => ISSUE_LABELS[issue]).join(', ')} antes de facturar a su nombre.`
        : 'Faltan datos para facturar a nombre de esta persona.',
    details: { missing, invalid },
  });
}

const identificationTaken = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PATIENT_IDENTIFICATION_TAKEN',
    message: 'Ya existe un paciente con esa identificación.',
  });

const DEFAULT_PAGE_SIZE = 20;

/** The legal name as stored: a final consumer (07) always carries the canonical name. */
function storedLegalName(idType: SriIdType | string, rawName: string): string {
  const name = rawName.trim();
  if (idType !== '07') return name;
  return name.replace(/\s+/g, ' ').toUpperCase() === FINAL_CONSUMER_NAME
    ? FINAL_CONSUMER_NAME
    : name;
}

const profileNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'BILLING_PROFILE_NOT_FOUND',
    message: 'Perfil de facturación no encontrado.',
  });

const patientNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'PATIENT_NOT_FOUND',
    message: 'Paciente no encontrado.',
  });

const duplicate = () =>
  new ConflictException({
    statusCode: 409,
    code: 'BILLING_PROFILE_DUPLICATE',
    message: 'Ya existe un perfil de facturación con esa identificación.',
  });

const inactive = () =>
  new ConflictException({
    statusCode: 409,
    code: 'BILLING_PROFILE_INACTIVE',
    message: 'El perfil de facturación está inactivo.',
  });

const isUniqueViolation = (error: unknown) =>
  (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';

@Injectable()
export class BillingProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, query: ListBillingProfilesQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const q = query.q?.trim();
    const where: Prisma.BillingProfileWhereInput = {
      tenantId,
      ...(query.active !== undefined ? { isActive: query.active === 'true' } : {}),
      ...(q
        ? {
            OR: [
              { legalName: { contains: q, mode: 'insensitive' } },
              { idNumber: { startsWith: q } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.billingProfile.findMany({
        where,
        orderBy: { legalName: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.billingProfile.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async create(
    tenantId: string,
    actorId: string,
    dto: CreateBillingProfileDto,
  ): Promise<BillingProfile> {
    const idNumber = normalizeIdNumber(dto.idType, dto.idNumber);
    const legalName = storedLegalName(dto.idType, dto.legalName);
    assertValidTaxIdentification(dto.idType, idNumber, legalName);

    try {
      return await runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
        const existing = await tx.billingProfile.findFirst({
          where: { tenantId, idType: dto.idType, idNumber },
          select: { id: true },
        });
        if (existing) throw duplicate();

        const created = await tx.billingProfile.create({
          data: {
            tenantId,
            kind: dto.kind,
            idType: dto.idType,
            idNumber,
            legalName,
            email: dto.email?.trim() || null,
            address: dto.address?.trim() || null,
            phone: dto.phone?.trim() || null,
            createdById: actorId,
          },
        });
        await recordBillingAudit(tx, {
          tenantId,
          actorId,
          action: 'CREATE',
          entity: 'BILLING_PROFILE',
          entityId: created.id,
          // The identification number is not copied into the audit trail.
          changes: { after: { kind: created.kind, idType: created.idType, legalName } },
        });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicate();
      throw error;
    }
  }

  async get(tenantId: string, id: string): Promise<BillingProfile> {
    const profile = await this.prisma.billingProfile.findFirst({ where: { id, tenantId } });
    if (!profile) throw profileNotFound();
    return profile;
  }

  async update(
    tenantId: string,
    actorId: string,
    id: string,
    dto: UpdateBillingProfileDto,
  ): Promise<BillingProfile> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const current = await tx.billingProfile.findFirst({ where: { id, tenantId } });
      if (!current) throw profileNotFound();

      // Only these fields are ever written: idType and idNumber are immutable.
      const data: Prisma.BillingProfileUpdateInput = {};
      if (dto.legalName !== undefined) {
        const legalName = storedLegalName(current.idType, dto.legalName);
        assertValidTaxIdentification(current.idType, current.idNumber, legalName);
        data.legalName = legalName;
      }
      // null clears the field; the e-mail may only be cleared on a final-consumer profile.
      if (dto.email !== undefined) {
        const email = dto.email?.trim() || null;
        if (email === null && current.idType !== '07') {
          throw new UnprocessableEntityException({
            statusCode: 422,
            code: 'BILLING_PROFILE_INVALID',
            message: 'El correo electrónico es obligatorio.',
          });
        }
        data.email = email;
      }
      if (dto.address !== undefined) data.address = dto.address?.trim() || null;
      if (dto.phone !== undefined) data.phone = dto.phone?.trim() || null;
      if (dto.isActive !== undefined) data.isActive = dto.isActive;

      const updated = await tx.billingProfile.update({ where: { id }, data });
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'BILLING_PROFILE',
        entityId: id,
        changes: {
          idType: current.idType,
          before: pickEditable(current),
          after: pickEditable(updated),
        },
      });
      return updated;
    });
  }

  async listForPatient(tenantId: string, patientId: string): Promise<LinkedBillingProfile[]> {
    await this.assertPatient(this.prisma, tenantId, patientId);
    return this.linked(this.prisma, tenantId, patientId);
  }

  async linkToPatient(
    tenantId: string,
    actorId: string,
    patientId: string,
    dto: LinkBillingProfileDto,
  ): Promise<LinkedBillingProfile[]> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      await this.assertPatient(tx, tenantId, patientId);
      const profile = await tx.billingProfile.findFirst({
        where: { id: dto.billingProfileId, tenantId },
      });
      if (!profile) throw profileNotFound();
      if (!profile.isActive) throw inactive();

      const isDefault = dto.isDefault === true;
      if (isDefault) {
        await tx.patientBillingProfile.updateMany({
          where: { tenantId, patientId, isDefault: true },
          data: { isDefault: false },
        });
      }
      await tx.patientBillingProfile.upsert({
        where: { patientId_billingProfileId: { patientId, billingProfileId: profile.id } },
        create: { tenantId, patientId, billingProfileId: profile.id, isDefault },
        // Linking again without isDefault keeps the current flag.
        update: isDefault ? { isDefault: true } : {},
      });
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'BILLING_PROFILE',
        entityId: profile.id,
        changes: { idType: profile.idType, linkedPatientId: patientId, isDefault },
      });
      return this.linked(tx, tenantId, patientId);
    });
  }

  async unlinkFromPatient(
    tenantId: string,
    actorId: string,
    patientId: string,
    profileId: string,
  ): Promise<void> {
    await runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      await this.assertPatient(tx, tenantId, patientId);
      const { count } = await tx.patientBillingProfile.deleteMany({
        where: { tenantId, patientId, billingProfileId: profileId },
      });
      if (count === 0) throw profileNotFound();
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'BILLING_PROFILE',
        entityId: profileId,
        changes: { unlinkedPatientId: patientId },
      });
    });
  }

  /**
   * The patient's own billing profile, built from the patient record and linked to it (as the
   * default when the patient has none yet). Data the record lacks may come in `dto`: it is
   * written to the patient first, and a field the record already has is never overwritten.
   * 422 PATIENT_BILLING_DATA_INCOMPLETE names what is still missing; 409 BILLING_PROFILE_INACTIVE
   * or PATIENT_IDENTIFICATION_TAKEN.
   */
  async billAsPatient(
    tenantId: string,
    actorId: string,
    patientId: string,
    dto: BillAsPatientDto,
  ): Promise<LinkedBillingProfile> {
    try {
      return await runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
        // Completing the record writes to the patient: like PATCH /patients/:id, only while the
        // clinic has the patient records section on. Billing with the data on file does not.
        if (Object.values(dto).some((value) => value !== undefined)) {
          await assertSectionInEffect(tx, tenantId, 'core.patients.records');
        }
        const patient = await tx.patient.findFirst({
          where: { id: patientId, tenantId, deletedAt: null },
          select: PATIENT_BILLING_SELECT,
        });
        if (!patient) throw patientNotFound();

        const fill = await this.patientFieldsToFill(tx, tenantId, patientId, patient, dto);
        const completedFields = Object.keys(fill);
        if (completedFields.length > 0) {
          await tx.patient.update({ where: { id: patientId }, data: fill, select: { id: true } });
        }

        // In the patient's own name: a legacy fiscal identity of the record is not used here.
        const profileId = await patientBillingProfileId(tx, tenantId, actorId, patientId, OWN);
        if (!profileId) {
          const draft = patientBillingDraft({ ...patient, ...fill }, OWN);
          if (!draft.issues.includes('identification')) {
            const { idType, idNumber } = draft.data;
            const deactivated = await tx.billingProfile.findFirst({
              where: { tenantId, idType, idNumber, isActive: false },
              select: { id: true },
            });
            if (deactivated) throw inactive();
          }
          throw patientBillingDataIncomplete(draft);
        }

        const currentDefault = await tx.patientBillingProfile.findFirst({
          where: { tenantId, patientId, isDefault: true },
          select: { billingProfileId: true },
        });
        if (!currentDefault) {
          await tx.patientBillingProfile.update({
            where: { patientId_billingProfileId: { patientId, billingProfileId: profileId } },
            data: { isDefault: true },
          });
        }
        if (completedFields.length > 0) {
          await recordBillingAudit(tx, {
            tenantId,
            actorId,
            action: 'UPDATE',
            entity: 'BILLING_PROFILE',
            entityId: profileId,
            changes: { completedPatientId: patientId, completedFields, source: 'PATIENT_DATA' },
          });
        }

        const linked = await this.linked(tx, tenantId, patientId);
        const own = linked.find((profile) => profile.id === profileId);
        if (!own) throw profileNotFound();
        return own;
      });
    } catch (error) {
      // The partial unique index on the patient identification backs the check against races.
      const meta = (error as Prisma.PrismaClientKnownRequestError)?.meta;
      if (
        isUniqueViolation(error) &&
        (meta?.modelName === 'Patient' || String(meta?.target ?? '').includes('identification'))
      ) {
        throw identificationTaken();
      }
      throw error;
    }
  }

  /** The fields of `dto` the patient record does not have yet, validated and normalized. */
  private async patientFieldsToFill(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    patient: PatientBillingSource,
    dto: BillAsPatientDto,
  ): Promise<PatientFill> {
    const fill: PatientFill = {};

    if (dto.identificationNumber && blank(patient.identificationNumber)) {
      const identification = mergePatientIdentification(null, {
        identificationType: dto.identificationType,
        identificationNumber: dto.identificationNumber,
      });
      const idType = PATIENT_ID_TYPES[identification.identificationType ?? ''] as SriIdType;
      const legalName = `${patient.firstName.trim()} ${patient.lastName.trim()}`.trim();
      assertValidTaxIdentification(
        idType,
        normalizeIdNumber(idType, identification.identificationNumber ?? ''),
        legalName,
      );
      const other = await tx.patient.findFirst({
        where: {
          tenantId,
          identificationType: identification.identificationType,
          identificationNumber: identification.identificationNumber,
          deletedAt: null,
          id: { not: patientId },
        },
        select: { id: true },
      });
      if (other) throw identificationTaken();
      fill.identificationType = identification.identificationType ?? undefined;
      fill.identificationNumber = identification.identificationNumber ?? undefined;
    }
    for (const field of ['email', 'address', 'phone'] as const) {
      const value = dto[field]?.trim();
      if (value && blank(patient[field])) fill[field] = value;
    }
    return fill;
  }

  private async assertPatient(
    db: PrismaService | Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
  ): Promise<void> {
    const patient = await db.patient.findFirst({
      where: { id: patientId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!patient) throw patientNotFound();
  }

  private async linked(
    db: PrismaService | Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
  ): Promise<LinkedBillingProfile[]> {
    const links = await db.patientBillingProfile.findMany({
      where: { tenantId, patientId },
      include: { billingProfile: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    return links.map((link) => ({ ...link.billingProfile, isDefault: link.isDefault }));
  }
}

function pickEditable(profile: BillingProfile) {
  return {
    legalName: profile.legalName,
    email: profile.email,
    address: profile.address,
    phone: profile.phone,
    isActive: profile.isActive,
  };
}
