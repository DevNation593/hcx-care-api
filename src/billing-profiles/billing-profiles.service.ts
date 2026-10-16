import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BillingProfile, Prisma } from '@prisma/client';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import {
  CreateBillingProfileDto,
  LinkBillingProfileDto,
  ListBillingProfilesQuery,
  UpdateBillingProfileDto,
} from './dto/billing-profile.dto';
import { assertValidTaxIdentification, normalizeIdNumber } from './tax-identification';

export type LinkedBillingProfile = BillingProfile & { isDefault: boolean };

const DEFAULT_PAGE_SIZE = 20;

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
    const legalName = dto.legalName.trim();
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
        const legalName = dto.legalName.trim();
        assertValidTaxIdentification(current.idType, current.idNumber, legalName);
        data.legalName = legalName;
      }
      if (dto.email !== undefined) data.email = dto.email.trim() || null;
      if (dto.address !== undefined) data.address = dto.address.trim() || null;
      if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;
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
