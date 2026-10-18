import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { EmiteFacilProvider } from './provider/emite-facil.provider';
import { ProviderError } from './provider/invoicing-provider';
import { EmissionPointDto, SaveConnectionDto, TestConnectionDto } from './dto/invoicing.dto';
import { invoiceError } from './invoice-errors';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
@Injectable()
export class ConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    private readonly provider: EmiteFacilProvider,
    private readonly config: ConfigService,
  ) {}
  requireEncryption() {
    if (!this.crypto.enabled) throw invoiceError('INVOICING_ENCRYPTION_REQUIRED', 503);
  }
  async get(tenantId: string) {
    const c = await this.prisma.invoicingConnection.findUnique({
      where: { tenantId },
      include: { points: true },
    });
    if (!c) return null;
    const prefix = (this.config.get<string>('API_PREFIX') || 'api/v1').replace(/^\/+|\/+$/g, '');
    let webhookUrl: string | null = null;
    try {
      const publicUrl = new URL(this.config.get<string>('BACKEND_PUBLIC_URL') || '');
      if (
        ['http:', 'https:'].includes(publicUrl.protocol) &&
        !publicUrl.username &&
        !publicUrl.password &&
        !publicUrl.search &&
        !publicUrl.hash
      )
        webhookUrl = `${publicUrl.toString().replace(/\/$/, '')}/${prefix}/integrations/emite-facil/webhook/${c.id}`;
    } catch {}
    return {
      id: c.id,
      active: c.active,
      externalTenantId: c.externalTenantId,
      taxpayerId: c.taxpayerId,
      taxpayerName: c.taxpayerName,
      taxpayerRuc: c.taxpayerRuc,
      environment: c.environment,
      hasApiKey: true,
      hasWebhookSecret: !!c.webhookSecretEncrypted,
      revision: c.revision,
      validatedAt: c.validatedAt,
      webhookUrl,
      points: c.points.map((p) => ({
        branchId: p.branchId,
        establishmentId: p.establishmentId,
        emissionPointId: p.emissionPointId,
        establishmentCode: p.establishmentCode,
        emissionPointCode: p.emissionPointCode,
      })),
    };
  }
  async test(tenantId: string, dto: TestConnectionDto) {
    const saved = await this.prisma.invoicingConnection.findUnique({ where: { tenantId } });
    const key =
      dto.apiKey ?? (saved ? this.crypto.decrypt(tenantId, saved.apiKeyEncrypted) : undefined);
    if (!key) throw invoiceError('INVOICING_API_KEY_REQUIRED', 422);
    try {
      const client = this.provider.client(key);
      const tenant = await client.getTenant();
      if (tenant.status !== 'ACTIVE') throw invoiceError('INVOICING_TENANT_INACTIVE', 422);
      return { tenant, taxpayers: await client.listTaxpayers() };
    } catch (e) {
      if (e instanceof ProviderError)
        throw invoiceError(e.code, e.kind === 'transient' ? 503 : 422);
      throw e;
    }
  }
  async options(tenantId: string) {
    const tested = await this.test(tenantId, {});
    const c = await this.prisma.invoicingConnection.findUniqueOrThrow({ where: { tenantId } });
    const client = this.provider.client(this.crypto.decrypt(tenantId, c.apiKeyEncrypted));
    try {
      const taxpayers = [];
      for (const t of tested.taxpayers) {
        const establishments = [];
        for (const e of await client.listEstablishments(t.id)) {
          establishments.push({
            ...e,
            emissionPoints: await client.listEmissionPoints(t.id, e.id),
          });
        }
        taxpayers.push({ ...t, establishments });
      }
      return { ...tested, taxpayers };
    } catch (e) {
      if (e instanceof ProviderError) throw invoiceError(e.code, 503);
      throw e;
    }
  }
  async save(tenantId: string, userId: string, dto: SaveConnectionDto) {
    this.requireEncryption();
    const initial = await this.prisma.invoicingConnection.findUnique({ where: { tenantId } });
    const testedKey =
      dto.apiKey ?? (initial ? this.crypto.decrypt(tenantId, initial.apiKeyEncrypted) : undefined);
    const tested = await this.test(tenantId, { apiKey: testedKey });
    const taxpayer = tested.taxpayers.find((t) => t.id === dto.taxpayerId);
    if (!taxpayer) throw invoiceError('INVOICING_TAXPAYER_INVALID', 422);
    await runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      const previous = await tx.invoicingConnection.findUnique({ where: { tenantId } });
      if (
        previous?.id !== initial?.id ||
        previous?.revision !== initial?.revision ||
        previous?.apiKeyEncrypted !== initial?.apiKeyEncrypted
      )
        throw invoiceError('INVOICING_CONFIGURATION_CHANGED');
      const changed =
        previous &&
        (previous.externalTenantId !== tested.tenant.id || previous.taxpayerId !== taxpayer.id);
      if (changed && (await tx.invoiceRequest.count({ where: { connectionId: previous.id } })))
        throw invoiceError('INVOICING_IDENTITY_LOCKED');
      if (
        previous &&
        previous.environment !== taxpayer.defaultEnvironment &&
        (await tx.invoiceRequest.count({
          where: {
            connectionId: previous.id,
            OR: [
              { status: { in: ['REQUESTED', 'PROCESSING'] } },
              { requiresReconciliation: true },
              { status: 'AUTHORIZED', OR: [{ xmlStorageKey: null }, { rideStorageKey: null }] },
            ],
          },
        }))
      )
        throw invoiceError('INVOICING_ENVIRONMENT_BUSY');
      if (changed)
        await tx.branchEmissionPoint.deleteMany({ where: { connectionId: previous.id } });
      const key = dto.apiKey
        ? this.crypto.encrypt(tenantId, dto.apiKey)
        : previous?.apiKeyEncrypted;
      if (!key) throw invoiceError('INVOICING_API_KEY_REQUIRED', 422);
      const data = {
        apiKeyEncrypted: key,
        externalTenantId: tested.tenant.id,
        taxpayerId: taxpayer.id,
        taxpayerName: taxpayer.legalName,
        taxpayerRuc: taxpayer.ruc,
        environment: taxpayer.defaultEnvironment,
        active: dto.active ?? true,
        validatedAt: new Date(),
        ...(dto.webhookSecret !== undefined
          ? {
              webhookSecretEncrypted: dto.webhookSecret
                ? this.crypto.encrypt(tenantId, dto.webhookSecret)
                : null,
            }
          : {}),
      };
      await tx.invoicingConnection.upsert({
        where: { tenantId },
        create: { tenantId, ...data },
        update: { ...data, revision: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          entity: 'INVOICE_REQUEST',
          entityId: previous?.id ?? tenantId,
          action: 'UPDATE',
          changes: { operation: 'CONNECTION_SAVED', keyRotated: !!dto.apiKey },
        },
      });
    });
    return this.get(tenantId);
  }
  async setPoint(tenantId: string, userId: string, branchId: string, dto: EmissionPointDto) {
    const options = await this.options(tenantId);
    const c = await this.prisma.invoicingConnection.findUniqueOrThrow({ where: { tenantId } });
    const taxpayer = options.taxpayers.find((t) => t.id === c.taxpayerId);
    const establishment = taxpayer?.establishments.find(
      (e) => e.id === dto.establishmentId && e.taxpayerId === c.taxpayerId,
    );
    const point = establishment?.emissionPoints.find(
      (p) => p.id === dto.emissionPointId && p.establishmentId === establishment.id && p.enabled,
    );
    if (!establishment || !point) throw invoiceError('INVOICING_POINT_INVALID', 422);
    await runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      const current = await tx.invoicingConnection.findUniqueOrThrow({ where: { tenantId } });
      if (current.revision !== c.revision) throw invoiceError('INVOICING_CONFIGURATION_CHANGED');
      if (!(await tx.branch.findFirst({ where: { id: branchId, tenantId } })))
        throw invoiceError('BRANCH_NOT_FOUND', 404);
      const data = {
        connectionId: c.id,
        establishmentId: establishment.id,
        emissionPointId: point.id,
        establishmentCode: establishment.code,
        emissionPointCode: point.code,
      };
      await tx.branchEmissionPoint.upsert({
        where: { branchId },
        create: { branchId, ...data },
        update: data,
      });
    });
    return (await this.get(tenantId))!.points.find((p) => p.branchId === branchId);
  }
}
