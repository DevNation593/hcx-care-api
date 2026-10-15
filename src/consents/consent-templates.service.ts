import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConsentTemplateVersion, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { consentChecksum } from './consent-text';
import { CreateConsentTemplateDto, SaveConsentDraftDto } from './dto/consent-template.dto';

/** The listing leaves the text out; it can be long and the screen only needs the state. */
const summaryInclude = {
  versions: {
    select: {
      id: true,
      version: true,
      title: true,
      status: true,
      checksum: true,
      publishedAt: true,
      retiredAt: true,
      createdAt: true,
    },
    orderBy: { version: 'desc' },
  },
} satisfies Prisma.ConsentTemplateInclude;

const fullInclude = {
  versions: { orderBy: { version: 'desc' } },
} satisfies Prisma.ConsentTemplateInclude;

export type ConsentTemplateSummary = Prisma.ConsentTemplateGetPayload<{
  include: typeof summaryInclude;
}>;
export type ConsentTemplateWithVersions = Prisma.ConsentTemplateGetPayload<{
  include: typeof fullInclude;
}>;

type ConsentDb = PrismaService | Prisma.TransactionClient;

const isUniqueViolation = (error: unknown) =>
  (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';

const notFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'CONSENT_TEMPLATE_NOT_FOUND',
    message: 'Plantilla de consentimiento no encontrada.',
  });

const locked = (message: string) =>
  new ConflictException({ statusCode: 409, code: 'CONSENT_VERSION_LOCKED', message });

const nameTaken = () =>
  new ConflictException({
    statusCode: 409,
    code: 'CONSENT_TEMPLATE_NAME_TAKEN',
    message: 'Ya existe una plantilla de consentimiento con ese nombre.',
  });

/**
 * Consent texts of the clinic. A version is edited only while it is a draft: once published
 * its text is what patients sign, so a change is a new version. `currentVersion` is the number
 * of the latest published version (1 until the first publish); callers read each version's
 * status rather than rely on it alone.
 */
@Injectable()
export class ConsentTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string): Promise<ConsentTemplateSummary[]> {
    return this.prisma.consentTemplate.findMany({
      where: { tenantId },
      include: summaryInclude,
      orderBy: { name: 'asc' },
    });
  }

  get(tenantId: string, id: string): Promise<ConsentTemplateWithVersions> {
    return this.findOwn(this.prisma, tenantId, id);
  }

  async create(
    tenantId: string,
    userId: string,
    dto: CreateConsentTemplateDto,
  ): Promise<ConsentTemplateWithVersions> {
    const title = dto.title.trim();
    const body = dto.body.trim();

    try {
      return await this.transaction((tx) =>
        tx.consentTemplate.create({
          data: {
            tenantId,
            name: dto.name.trim(),
            currentVersion: 1,
            versions: {
              create: {
                tenantId,
                version: 1,
                title,
                body,
                checksum: consentChecksum(title, body),
                status: 'DRAFT',
                createdById: userId,
              },
            },
          },
          include: fullInclude,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /** Replaces the text of the open draft, or starts the next version as a draft. */
  async saveDraft(
    tenantId: string,
    userId: string,
    id: string,
    dto: SaveConsentDraftDto,
  ): Promise<ConsentTemplateWithVersions> {
    const title = dto.title.trim();
    const body = dto.body.trim();
    const checksum = consentChecksum(title, body);

    try {
      return await this.transaction(async (tx) => {
        const template = await this.findOwn(tx, tenantId, id);
        const draft = template.versions.find((version) => version.status === 'DRAFT');

        if (draft) {
          await tx.consentTemplateVersion.update({
            where: { id: draft.id },
            data: { title, body, checksum },
          });
        } else {
          // Versions are listed newest first; the next number follows the highest one.
          const next = (template.versions[0]?.version ?? 0) + 1;
          await tx.consentTemplateVersion.create({
            data: {
              tenantId,
              templateId: id,
              version: next,
              title,
              body,
              checksum,
              status: 'DRAFT',
              createdById: userId,
            },
          });
        }
        return this.findOwn(tx, tenantId, id);
      });
    } catch (error) {
      // A concurrent request created the same version number first.
      if (isUniqueViolation(error)) {
        throw locked('La plantilla cambió mientras la editabas. Vuelve a cargarla.');
      }
      throw error;
    }
  }

  async publish(
    tenantId: string,
    _userId: string,
    id: string,
  ): Promise<ConsentTemplateWithVersions> {
    return this.transaction(async (tx) => {
      const template = await this.findOwn(tx, tenantId, id);
      const draft = template.versions.find((version) => version.status === 'DRAFT');
      if (!draft) throw locked('La plantilla no tiene un borrador para publicar.');

      // Guarded on the status so two concurrent publishes cannot both succeed.
      const { count } = await tx.consentTemplateVersion.updateMany({
        where: { id: draft.id, tenantId, status: 'DRAFT' },
        data: {
          status: 'PUBLISHED',
          checksum: consentChecksum(draft.title, draft.body),
          publishedAt: new Date(),
        },
      });
      if (count === 0) throw locked('El borrador ya fue publicado.');

      await tx.consentTemplate.update({
        where: { id },
        data: { currentVersion: draft.version },
      });
      return this.findOwn(tx, tenantId, id);
    });
  }

  retire(tenantId: string, versionId: string): Promise<ConsentTemplateVersion> {
    return this.transaction(async (tx) => {
      const version = await tx.consentTemplateVersion.findFirst({
        where: { id: versionId, tenantId },
      });
      if (!version) throw notFound();
      if (version.status !== 'PUBLISHED') {
        throw locked('Solo se puede retirar una versión publicada.');
      }

      return tx.consentTemplateVersion.update({
        where: { id: versionId },
        data: { status: 'RETIRED', retiredAt: new Date() },
      });
    });
  }

  /** A treatment can only point at a published version of the clinic's own templates. */
  async assertPublishedVersion(
    db: ConsentDb,
    tenantId: string,
    versionId: string,
  ): Promise<ConsentTemplateVersion> {
    const version = await db.consentTemplateVersion.findFirst({
      where: { id: versionId, tenantId },
    });
    if (!version || version.status !== 'PUBLISHED') {
      throw new BadRequestException({
        statusCode: 400,
        code: 'TREATMENT_REQUIREMENTS_INVALID',
        message: 'Los requisitos del tratamiento no son válidos.',
        issues: ['consentTemplateVersionId debe ser una versión publicada de la clínica.'],
      });
    }
    return version;
  }

  private async findOwn(
    db: ConsentDb,
    tenantId: string,
    id: string,
  ): Promise<ConsentTemplateWithVersions> {
    const template = await db.consentTemplate.findFirst({
      where: { id, tenantId },
      include: fullInclude,
    });
    if (!template) throw notFound();
    return template;
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
