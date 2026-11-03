import { Inject, Injectable, Logger } from '@nestjs/common';
import { BranchEmissionPoint, InvoiceSequence, InvoicingIssuer } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { isValidRuc } from '../billing-profiles/tax-identification';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { FILE_STORAGE, FileStorage } from '../patient-files/file-storage';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { IssuerEmissionPointDto, SaveIssuerDto } from './dto/issuer.dto';
import { invoiceError } from './invoice-errors';
import { certificateMatchesRuc, openCertificate, SigningMaterial } from './sri/certificate';
import { SriClient } from './sri/sri-client';
import { RimpeRegime, SriEnvironment, SriError } from './sri/sri-types';

export interface IssuerPointView {
  branchId: string;
  establishmentCode: string;
  emissionPointCode: string;
  establishmentAddress: string;
  nextSequential: number;
}

export interface IssuerView {
  id: string;
  ruc: string;
  legalName: string;
  tradeName: string | null;
  headOfficeAddress: string;
  accountingRequired: boolean;
  specialTaxpayerCode: string | null;
  withholdingAgentCode: string | null;
  rimpeRegime: RimpeRegime;
  environment: SriEnvironment;
  active: boolean;
  revision: number;
  certificate: {
    subject: string;
    serial: string;
    validTo: string;
    sha256: string;
    rucVerified: boolean;
  } | null;
  points: IssuerPointView[];
}

export interface IssuerTestResult {
  certificateValid: boolean;
  certificateError: string | null;
  rucVerified: boolean;
  sriReachable: boolean;
}

type IssuerRow = InvoicingIssuer & { points: BranchEmissionPoint[]; sequences: InvoiceSequence[] };

function toView(issuer: IssuerRow): IssuerView {
  const environment = issuer.environment as SriEnvironment;
  return {
    id: issuer.id,
    ruc: issuer.ruc,
    legalName: issuer.legalName,
    tradeName: issuer.tradeName,
    headOfficeAddress: issuer.headOfficeAddress,
    accountingRequired: issuer.accountingRequired,
    specialTaxpayerCode: issuer.specialTaxpayerCode,
    withholdingAgentCode: issuer.withholdingAgentCode,
    rimpeRegime: issuer.rimpeRegime,
    environment,
    active: issuer.active,
    revision: issuer.revision,
    certificate:
      issuer.certificateStorageKey && issuer.certificateSha256 && issuer.certificateValidTo
        ? {
            subject: issuer.certificateSubject ?? '',
            serial: issuer.certificateSerial ?? '',
            validTo: issuer.certificateValidTo.toISOString(),
            sha256: issuer.certificateSha256,
            rucVerified: issuer.certificateRucVerified,
          }
        : null,
    points: issuer.points.map((p) => ({
      branchId: p.branchId,
      establishmentCode: p.establishmentCode,
      emissionPointCode: p.emissionPointCode,
      establishmentAddress: p.establishmentAddress,
      nextSequential:
        issuer.sequences.find(
          (s) =>
            s.establishmentCode === p.establishmentCode &&
            s.emissionPointCode === p.emissionPointCode &&
            s.environment === environment,
        )?.next ?? 1,
    })),
  };
}

/** The clinic as its own SRI issuer: tax data, signing certificate and emission points. */
@Injectable()
export class IssuerService {
  private readonly logger = new Logger(IssuerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    private readonly sri: SriClient,
  ) {}

  private requireEncryption() {
    if (!this.crypto.enabled) throw invoiceError('INVOICING_ENCRYPTION_REQUIRED', 503);
  }

  async get(tenantId: string): Promise<IssuerView | null> {
    const issuer = await this.prisma.invoicingIssuer.findUnique({
      where: { tenantId },
      include: { points: true, sequences: true },
    });
    return issuer ? toView(issuer) : null;
  }

  async save(tenantId: string, userId: string, dto: SaveIssuerDto): Promise<IssuerView> {
    this.requireEncryption();
    if (dto.rimpeRegime === 'NEGOCIO_POPULAR') throw invoiceError('RIMPE_REGIME_UNSUPPORTED', 422);
    if (!isValidRuc(dto.ruc)) throw invoiceError('INVOICING_RUC_INVALID', 422);
    const initial = await this.prisma.invoicingIssuer.findUnique({ where: { tenantId } });
    if (dto.revision !== undefined && dto.revision !== initial?.revision)
      throw invoiceError('INVOICING_CONFIGURATION_CHANGED');
    // Opening the certificate is slow, so a new RUC is checked against it before the transaction;
    // the revision check below discards the result if the certificate changes meanwhile.
    const rucVerified =
      initial && initial.ruc !== dto.ruc
        ? await this.certificateNamesRuc(initial, dto.ruc)
        : (initial?.certificateRucVerified ?? false);
    await runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      const previous = await tx.invoicingIssuer.findUnique({ where: { tenantId } });
      if (previous?.id !== initial?.id || previous?.revision !== initial?.revision)
        throw invoiceError('INVOICING_CONFIGURATION_CHANGED');
      if (
        previous &&
        previous.ruc !== dto.ruc &&
        (await tx.invoiceRequest.count({ where: { issuerId: previous.id } }))
      )
        throw invoiceError('INVOICING_IDENTITY_LOCKED');
      if (
        previous &&
        previous.environment !== dto.environment &&
        (await tx.invoiceRequest.count({
          where: {
            issuerId: previous.id,
            OR: [
              { status: { in: ['REQUESTED', 'PROCESSING'] } },
              { status: 'AUTHORIZED', OR: [{ xmlStorageKey: null }, { rideStorageKey: null }] },
            ],
          },
        }))
      )
        throw invoiceError('INVOICING_ENVIRONMENT_BUSY');
      const data = {
        ruc: dto.ruc,
        legalName: dto.legalName.trim(),
        tradeName: dto.tradeName?.trim() || null,
        headOfficeAddress: dto.headOfficeAddress.trim(),
        accountingRequired: dto.accountingRequired,
        specialTaxpayerCode: dto.specialTaxpayerCode || null,
        withholdingAgentCode: dto.withholdingAgentCode || null,
        rimpeRegime: dto.rimpeRegime,
        environment: dto.environment,
        active: dto.active ?? previous?.active ?? true,
        certificateRucVerified: rucVerified,
      };
      const issuer = await tx.invoicingIssuer.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: { ...data, revision: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          entity: 'INVOICE_REQUEST',
          entityId: issuer.id,
          action: previous ? 'UPDATE' : 'CREATE',
          changes: {
            operation: 'ISSUER_SAVED',
            rucChanged: !!previous && previous.ruc !== dto.ruc,
            environment: dto.environment,
            active: data.active,
          },
        },
      });
    });
    return (await this.get(tenantId))!;
  }

  async saveCertificate(
    tenantId: string,
    userId: string,
    file: Buffer,
    password: string,
  ): Promise<IssuerView> {
    this.requireEncryption();
    if (!file?.length) throw invoiceError('INVOICING_CERTIFICATE_REQUIRED', 422);
    const initial = await this.prisma.invoicingIssuer.findUnique({ where: { tenantId } });
    if (!initial) throw invoiceError('INVOICING_NOT_CONFIGURED', 422);
    let material: SigningMaterial;
    try {
      material = openCertificate(file, password);
    } catch (error) {
      if (error instanceof SriError) throw invoiceError(error.code, 422);
      throw error;
    }
    const match = certificateMatchesRuc(material, initial.ruc);
    if (match === 'MISMATCH') throw invoiceError('CERTIFICATE_RUC_MISMATCH', 422);
    const sha256 = createHash('sha256').update(file).digest('hex');
    const key = `invoicing-issuers/${tenantId}/${initial.id}/certificate-${randomUUID()}`;
    try {
      await this.storage.put(key, this.crypto.encryptBuffer(tenantId, file));
    } catch {
      await this.discard(key);
      throw invoiceError('INVOICING_CERTIFICATE_UNAVAILABLE', 503);
    }
    let previousKey: string | null;
    try {
      previousKey = await runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
        const current = await tx.invoicingIssuer.findUnique({ where: { tenantId } });
        if (current?.id !== initial.id || current.revision !== initial.revision)
          throw invoiceError('INVOICING_CONFIGURATION_CHANGED');
        await tx.invoicingIssuer.update({
          where: { tenantId },
          data: {
            certificateStorageKey: key,
            certificatePasswordEncrypted: this.crypto.encrypt(tenantId, password),
            certificateSubject: material.subject,
            certificateSerial: material.serial,
            certificateValidTo: material.validTo,
            certificateSha256: sha256,
            certificateRucVerified: match === 'MATCH',
            revision: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            userId,
            entity: 'INVOICE_REQUEST',
            entityId: initial.id,
            action: 'UPDATE',
            changes: {
              operation: 'CERTIFICATE_REPLACED',
              sha256,
              previousSha256: current.certificateSha256,
            },
          },
        });
        return current.certificateStorageKey;
      });
    } catch (error) {
      if (!(await this.certificateReferenced(tenantId, key))) await this.discard(key);
      throw error;
    }
    if (previousKey && previousKey !== key) await this.discard(previousKey);
    return (await this.get(tenantId))!;
  }

  /**
   * A failed COMMIT may still have committed. The new file is kept unless the issuer provably does
   * not point at it: an orphaned encrypted file is harmless, an issuer without its file is not.
   */
  private async certificateReferenced(tenantId: string, key: string): Promise<boolean> {
    try {
      return !!(await this.prisma.invoicingIssuer.findFirst({
        where: { tenantId, certificateStorageKey: key },
        select: { id: true },
      }));
    } catch {
      return true;
    }
  }

  /** Best effort: a file left behind is encrypted and unreferenced. */
  private async discard(key: string): Promise<void> {
    try {
      await this.storage.remove(key);
    } catch {
      this.logger.warn(`Certificate file ${key} could not be removed`);
    }
  }

  async test(tenantId: string): Promise<IssuerTestResult> {
    const issuer = await this.prisma.invoicingIssuer.findUnique({ where: { tenantId } });
    if (!issuer) throw invoiceError('INVOICING_NOT_CONFIGURED', 422);
    let certificateError: string | null = null;
    let rucVerified = false;
    try {
      const match = certificateMatchesRuc(await this.loadSigningMaterial(issuer), issuer.ruc);
      rucVerified = match === 'MATCH';
      if (match === 'MISMATCH') certificateError = 'CERTIFICATE_RUC_MISMATCH';
    } catch (error) {
      if (!(error instanceof SriError)) throw error;
      certificateError = error.code;
    }
    return {
      certificateValid: certificateError === null,
      certificateError,
      rucVerified,
      sriReachable: await this.sri.ping(issuer.environment as SriEnvironment),
    };
  }

  async setPoint(
    tenantId: string,
    userId: string,
    branchId: string,
    dto: IssuerEmissionPointDto,
  ): Promise<IssuerPointView> {
    await runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      const issuer = await tx.invoicingIssuer.findUnique({ where: { tenantId } });
      if (!issuer) throw invoiceError('INVOICING_NOT_CONFIGURED', 422);
      if (!(await tx.branch.findFirst({ where: { id: branchId, tenantId } })))
        throw invoiceError('BRANCH_NOT_FOUND', 404);
      const series = {
        issuerId: issuer.id,
        establishmentCode: dto.establishmentCode,
        emissionPointCode: dto.emissionPointCode,
      };
      if (await tx.branchEmissionPoint.findFirst({ where: { ...series, NOT: { branchId } } }))
        throw invoiceError('INVOICING_SERIES_TAKEN');
      const key = { ...series, environment: issuer.environment };
      const sequence = await tx.invoiceSequence.findUnique({
        where: { issuerId_establishmentCode_emissionPointCode_environment: key },
      });
      if (sequence && dto.nextSequential !== undefined && dto.nextSequential < sequence.next)
        throw invoiceError('INVOICING_SEQUENCE_BACKWARDS');
      const point = { ...series, establishmentAddress: dto.establishmentAddress.trim() };
      await tx.branchEmissionPoint.upsert({
        where: { branchId },
        create: { branchId, ...point },
        update: point,
      });
      await tx.invoiceSequence.upsert({
        where: { issuerId_establishmentCode_emissionPointCode_environment: key },
        create: { ...key, next: dto.nextSequential ?? 1 },
        update: dto.nextSequential === undefined ? {} : { next: dto.nextSequential },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          entity: 'INVOICE_REQUEST',
          entityId: issuer.id,
          action: 'UPDATE',
          changes: {
            operation: 'EMISSION_POINT_SAVED',
            branchId,
            establishmentCode: dto.establishmentCode,
            emissionPointCode: dto.emissionPointCode,
            nextSequential: dto.nextSequential ?? null,
          },
        },
      });
    });
    return (await this.get(tenantId))!.points.find((p) => p.branchId === branchId)!;
  }

  /**
   * Reads, decrypts, verifies and opens the issuer certificate. Throws SriError: 'transient' when
   * the file cannot be read (drivers do not tell a missing file from an outage), 'configuration'
   * when it is missing from the issuer, altered or not usable.
   */
  async loadSigningMaterial(issuer: InvoicingIssuer): Promise<SigningMaterial> {
    if (!issuer.certificateStorageKey || !issuer.certificatePasswordEncrypted)
      throw new SriError('configuration', 'INVOICING_CERTIFICATE_REQUIRED');
    let encrypted: Buffer;
    try {
      encrypted = await this.storage.get(issuer.certificateStorageKey);
    } catch {
      throw new SriError('transient', 'INVOICING_CERTIFICATE_UNAVAILABLE');
    }
    let p12: Buffer;
    try {
      p12 = this.crypto.decryptBuffer(issuer.tenantId, encrypted);
    } catch {
      throw new SriError('configuration', 'CERTIFICATE_INTEGRITY');
    }
    if (createHash('sha256').update(p12).digest('hex') !== issuer.certificateSha256)
      throw new SriError('configuration', 'CERTIFICATE_INTEGRITY');
    return openCertificate(
      p12,
      this.crypto.decrypt(issuer.tenantId, issuer.certificatePasswordEncrypted),
    );
  }

  /** False when the certificate does not name the RUC or is unusable; 503 when it cannot be read. */
  private async certificateNamesRuc(issuer: InvoicingIssuer, ruc: string): Promise<boolean> {
    if (!issuer.certificateStorageKey) return false;
    try {
      return certificateMatchesRuc(await this.loadSigningMaterial(issuer), ruc) === 'MATCH';
    } catch (error) {
      if (!(error instanceof SriError)) throw error;
      if (error.kind === 'transient') throw invoiceError(error.code, 503);
      return false;
    }
  }
}
