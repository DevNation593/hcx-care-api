import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Treatment, TreatmentVersion } from '@prisma/client';
import { ConsentTemplatesService } from '../consents/consent-templates.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTreatmentDto, UpdateTreatmentDto } from './dto/treatment.dto';
import { parseTreatmentRequirements, TreatmentRequirements } from './treatment-requirements';

export interface TreatmentVersionInput {
  price: number;
  taxRatePercent: number;
  durationMinutes: number;
  formDefinitionId?: string | null;
  formVersion?: number | null;
  consentTemplateVersionId?: string | null;
  requirements?: unknown;
}

/** A version as the API returns it: money as JSON numbers and the requirements parsed. */
export type TreatmentVersionView = Omit<
  TreatmentVersion,
  'price' | 'taxRatePercent' | 'requirements'
> & {
  price: number;
  taxRatePercent: number;
  requirements: TreatmentRequirements;
};

export type TreatmentWithCurrent = Treatment & { current: TreatmentVersionView };
export type TreatmentWithVersions = Treatment & { versions: TreatmentVersionView[] };

type TreatmentDb = PrismaService | Prisma.TransactionClient;

const fullInclude = {
  versions: { orderBy: { version: 'desc' } },
} satisfies Prisma.TreatmentInclude;

// Versions are numbered consecutively, so the newest one is the current one.
const currentInclude = {
  versions: { orderBy: { version: 'desc' }, take: 1 },
} satisfies Prisma.TreatmentInclude;

const isUniqueViolation = (error: unknown) =>
  (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';

const notFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'TREATMENT_NOT_FOUND',
    message: 'Tratamiento no encontrado.',
  });

const nameTaken = () =>
  new ConflictException({
    statusCode: 409,
    code: 'TREATMENT_NAME_TAKEN',
    message: 'Ya existe un tratamiento con ese nombre.',
  });

const versionConflict = () =>
  new ConflictException({
    statusCode: 409,
    code: 'TREATMENT_VERSION_CONFLICT',
    message: 'El tratamiento cambió mientras se guardaba la versión. Vuelve a intentarlo.',
  });

const invalid = (issues: string[]) =>
  new BadRequestException({
    statusCode: 400,
    code: 'TREATMENT_REQUIREMENTS_INVALID',
    message: 'Los requisitos del tratamiento no son válidos.',
    issues,
  });

/** Whether `value` is a finite number within [min, max] with at most two decimals. */
const isAmount = (value: unknown, min: number, max: number): value is number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return false;
  }
  const cents = value * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-7;
};

/** Reads `raw[section][key] === true` from a document that may not be well formed. */
const flagOf = (raw: unknown, section: string, key: string): boolean => {
  const value = (raw as Record<string, Record<string, unknown> | undefined> | null | undefined)?.[
    section
  ];
  return typeof value === 'object' && value !== null && value[key] === true;
};

const issuesOf = (error: unknown): string[] | null => {
  if (!(error instanceof BadRequestException)) return null;
  const response = error.getResponse() as { issues?: unknown; message?: unknown };
  if (Array.isArray(response.issues)) return response.issues.map(String);
  return [typeof response.message === 'string' ? response.message : error.message];
};

/**
 * The clinic's treatment catalog. Price and requirements live in immutable versions: a change is
 * a new version, and sessions pin the version they were opened with.
 */
@Injectable()
export class TreatmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consentTemplates: ConsentTemplatesService,
  ) {}

  async list(tenantId: string, filters: { active?: boolean }): Promise<TreatmentWithCurrent[]> {
    const treatments = await this.prisma.treatment.findMany({
      where: { tenantId, ...(filters.active !== undefined ? { isActive: filters.active } : {}) },
      include: currentInclude,
      orderBy: { name: 'asc' },
    });
    return treatments.map(({ versions, ...treatment }) => ({
      ...treatment,
      current: toVersionView(versions[0]),
    }));
  }

  async get(tenantId: string, id: string): Promise<TreatmentWithVersions> {
    return toDetail(await this.findOwn(this.prisma, tenantId, id));
  }

  async create(
    tenantId: string,
    userId: string,
    dto: CreateTreatmentDto,
  ): Promise<TreatmentWithVersions> {
    try {
      return await this.transaction(async (tx) => {
        const issues = [
          ...(await this.specialtyIssues(tx, tenantId, dto.specialtyId)),
          ...(await this.versionIssues(tx, tenantId, dto.version)),
        ];
        if (issues.length > 0) throw invalid(issues);

        const created = await tx.treatment.create({
          data: {
            tenantId,
            name: dto.name.trim(),
            category: dto.category?.trim() || null,
            specialtyId: dto.specialtyId ?? null,
            currentVersion: 1,
            versions: { create: versionData(tenantId, userId, 1, dto.version) },
          },
          include: fullInclude,
        });
        return toDetail(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateTreatmentDto,
  ): Promise<TreatmentWithVersions> {
    try {
      return await this.transaction(async (tx) => {
        await this.findOwn(tx, tenantId, id);
        const issues = await this.specialtyIssues(tx, tenantId, dto.specialtyId);
        if (issues.length > 0) throw invalid(issues);

        const data: Prisma.TreatmentUncheckedUpdateInput = {};
        if (dto.name !== undefined) data.name = dto.name.trim();
        if (dto.category !== undefined) data.category = dto.category?.trim() || null;
        if (dto.specialtyId !== undefined) data.specialtyId = dto.specialtyId;
        if (dto.isActive !== undefined) data.isActive = dto.isActive;

        await tx.treatment.update({ where: { id }, data });
        return toDetail(await this.findOwn(tx, tenantId, id));
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  async addVersion(
    tenantId: string,
    userId: string,
    id: string,
    dto: TreatmentVersionInput,
  ): Promise<TreatmentWithVersions> {
    try {
      return await this.transaction(async (tx) => {
        const treatment = await this.findOwn(tx, tenantId, id);

        const issues = await this.versionIssues(tx, tenantId, dto);
        if (issues.length > 0) throw invalid(issues);

        // Guarded on the number read above: a concurrent addVersion that committed first
        // leaves no row to update, so two requests never claim the same version number.
        const next = treatment.currentVersion + 1;
        const { count } = await tx.treatment.updateMany({
          where: { id, tenantId, currentVersion: treatment.currentVersion },
          data: { currentVersion: next },
        });
        if (count === 0) throw versionConflict();

        await tx.treatmentVersion.create({
          data: { ...versionData(tenantId, userId, next, dto), treatmentId: id },
        });
        return toDetail(await this.findOwn(tx, tenantId, id));
      });
    } catch (error) {
      // The (treatmentId, version) unique caught a concurrent request the guard did not.
      if (isUniqueViolation(error)) throw versionConflict();
      throw error;
    }
  }

  /** The version a new session pins: the current version of an active treatment. */
  async currentVersionFor(
    db: TreatmentDb,
    tenantId: string,
    treatmentId: string,
  ): Promise<TreatmentVersion & { treatment: Treatment }> {
    const treatment = await db.treatment.findFirst({ where: { id: treatmentId, tenantId } });
    if (!treatment) throw notFound();
    if (!treatment.isActive) {
      throw new ConflictException({
        statusCode: 409,
        code: 'TREATMENT_INACTIVE',
        message: 'El tratamiento está inactivo y no admite nuevas atenciones.',
      });
    }

    const version = await db.treatmentVersion.findFirst({
      where: { treatmentId, tenantId, version: treatment.currentVersion },
    });
    if (!version) throw notFound();
    return { ...version, treatment };
  }

  private async specialtyIssues(
    db: TreatmentDb,
    tenantId: string,
    specialtyId: string | null | undefined,
  ): Promise<string[]> {
    if (!specialtyId) return [];
    const offered = await db.tenantSpecialty.findUnique({
      where: { tenantId_specialtyId: { tenantId, specialtyId } },
    });
    return offered ? [] : ['specialtyId debe ser una especialidad de la clínica.'];
  }

  /** Every problem of a version, so the form can show them all at once. */
  private async versionIssues(
    db: TreatmentDb,
    tenantId: string,
    input: TreatmentVersionInput,
  ): Promise<string[]> {
    const issues: string[] = [];

    if (!isAmount(input.price, 0, 999999.99)) {
      issues.push('price debe ser un monto entre 0 y 999999.99 con dos decimales.');
    }
    if (!isAmount(input.taxRatePercent, 0, 100)) {
      issues.push('taxRatePercent debe ser un porcentaje entre 0 y 100 con dos decimales.');
    }
    if (
      !Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < 5 ||
      input.durationMinutes > 1440
    ) {
      issues.push('durationMinutes debe ser un entero entre 5 y 1440.');
    }

    // Invalid requirements are reported, and the flags they do state still drive the checks
    // below so the form can show every issue at once.
    let requirements: Pick<TreatmentRequirements, 'medicalForm' | 'informedConsent'>;
    try {
      requirements = parseTreatmentRequirements(input.requirements ?? {});
    } catch (error) {
      const found = issuesOf(error);
      if (!found) throw error;
      issues.push(...found);
      requirements = {
        medicalForm: { required: flagOf(input.requirements, 'medicalForm', 'required') },
        informedConsent: {
          required: flagOf(input.requirements, 'informedConsent', 'required'),
          validityDays: null,
        },
      };
    }

    const { formDefinitionId, formVersion, consentTemplateVersionId } = input;
    const hasForm = formDefinitionId != null && formVersion != null;

    if ((formDefinitionId != null) !== (formVersion != null)) {
      issues.push('formDefinitionId y formVersion deben indicarse juntos.');
    } else if (hasForm) {
      const form = await db.formDefinitionVersion.findFirst({
        where: { formDefinitionId, version: formVersion, formDefinition: { tenantId } },
        select: { formDefinition: { select: { isActive: true } } },
      });
      if (!form) {
        issues.push('formDefinitionId y formVersion deben ser una versión de ficha de la clínica.');
      } else if (!form.formDefinition.isActive) {
        issues.push('La ficha médica debe estar activa.');
      }
    }

    if (requirements.medicalForm.required && formDefinitionId == null && formVersion == null) {
      issues.push('medicalForm.required exige formDefinitionId y formVersion.');
    }

    if (!requirements.informedConsent.required) {
      if (consentTemplateVersionId != null) {
        issues.push('consentTemplateVersionId solo se admite con informedConsent.required.');
      }
    } else if (consentTemplateVersionId == null) {
      issues.push('informedConsent.required exige consentTemplateVersionId.');
    } else {
      try {
        await this.consentTemplates.assertPublishedVersion(db, tenantId, consentTemplateVersionId);
      } catch (error) {
        const found = issuesOf(error);
        if (!found) throw error;
        issues.push(...found);
      }
    }

    return issues;
  }

  private async findOwn(
    db: TreatmentDb,
    tenantId: string,
    id: string,
  ): Promise<Prisma.TreatmentGetPayload<{ include: typeof fullInclude }>> {
    const treatment = await db.treatment.findFirst({
      where: { id, tenantId },
      include: fullInclude,
    });
    if (!treatment) throw notFound();
    return treatment;
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}

function versionData(
  tenantId: string,
  userId: string,
  version: number,
  input: TreatmentVersionInput,
): Prisma.TreatmentVersionUncheckedCreateWithoutTreatmentInput {
  return {
    tenantId,
    version,
    // Strings keep the two decimals exact on their way into the Decimal columns.
    price: input.price.toFixed(2),
    taxRatePercent: input.taxRatePercent.toFixed(2),
    durationMinutes: input.durationMinutes,
    formDefinitionId: input.formDefinitionId ?? null,
    formVersion: input.formVersion ?? null,
    consentTemplateVersionId: input.consentTemplateVersionId ?? null,
    requirements: parseTreatmentRequirements(
      input.requirements ?? {},
    ) as unknown as Prisma.InputJsonValue,
    createdById: userId,
  };
}

function toVersionView(version: TreatmentVersion): TreatmentVersionView {
  return {
    ...version,
    price: Number(version.price),
    taxRatePercent: Number(version.taxRatePercent),
    requirements: parseTreatmentRequirements(version.requirements),
  };
}

function toDetail(treatment: Treatment & { versions: TreatmentVersion[] }): TreatmentWithVersions {
  return { ...treatment, versions: treatment.versions.map(toVersionView) };
}
