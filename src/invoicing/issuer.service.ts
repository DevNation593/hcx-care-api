import { Injectable } from '@nestjs/common';
import { BranchEmissionPoint, InvoiceSequence, InvoicingIssuer } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isValidRuc } from '../billing-profiles/tax-identification';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
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
      issuer.certificateSha256 && issuer.certificateValidTo
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
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
        ? this.certificateNamesRuc(initial, dto.ruc)
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
    await runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      const current = await tx.invoicingIssuer.findUnique({ where: { tenantId } });
      if (current?.id !== initial.id || current.revision !== initial.revision)
        throw invoiceError('INVOICING_CONFIGURATION_CHANGED');
      await tx.invoicingIssuer.update({
        where: { tenantId },
        data: {
          certificateEncrypted: this.crypto.encryptBuffer(tenantId, file).toString('base64'),
          certificatePasswordEncrypted: this.crypto.encrypt(tenantId, password),
          certificateSubject: material.subject,
          certificateSerial: material.serial,
          certificateValidTo: material.validTo,
          certificateSha256: material.sha256,
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
            sha256: material.sha256,
            previousSha256: initial.certificateSha256,
          },
        },
      });
    });
    return (await this.get(tenantId))!;
  }

  async test(tenantId: string): Promise<IssuerTestResult> {
    const issuer = await this.prisma.invoicingIssuer.findUnique({ where: { tenantId } });
    if (!issuer) throw invoiceError('INVOICING_NOT_CONFIGURED', 422);
    let certificateError: string | null = null;
    let rucVerified = false;
    try {
      const match = certificateMatchesRuc(this.loadSigningMaterial(issuer), issuer.ruc);
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

  /** Decrypts and opens the issuer certificate; throws SriError('configuration', code). */
  loadSigningMaterial(issuer: InvoicingIssuer): SigningMaterial {
    if (!issuer.certificateEncrypted || !issuer.certificatePasswordEncrypted)
      throw new SriError('configuration', 'INVOICING_CERTIFICATE_REQUIRED');
    const p12 = this.crypto.decryptBuffer(
      issuer.tenantId,
      Buffer.from(issuer.certificateEncrypted, 'base64'),
    );
    return openCertificate(
      p12,
      this.crypto.decrypt(issuer.tenantId, issuer.certificatePasswordEncrypted),
    );
  }

  private certificateNamesRuc(issuer: InvoicingIssuer, ruc: string): boolean {
    if (!issuer.certificateEncrypted) return false;
    try {
      return certificateMatchesRuc(this.loadSigningMaterial(issuer), ruc) === 'MATCH';
    } catch (error) {
      if (error instanceof SriError) return false;
      throw error;
    }
  }
}
