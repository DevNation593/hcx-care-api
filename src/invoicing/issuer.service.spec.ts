import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { IssuerEmissionPointDto, SaveIssuerDto } from './dto/issuer.dto';
import { IssuerService } from './issuer.service';
import { createTestP12 } from './sri/testing/test-certificate';

function applyData(row: any, data: any) {
  const next = { ...row };
  for (const [key, value] of Object.entries(data)) {
    next[key] =
      value && typeof value === 'object' && 'increment' in (value as any)
        ? row[key] + (value as any).increment
        : value;
  }
  return next;
}

describe('IssuerService', () => {
  const tenant = 'clinic';
  const actor = 'master';
  const ruc = '1790012345001';
  const config = new ConfigService({
    CLINICAL_ENCRYPTION_KEYS: 'test:' + Buffer.alloc(32, 7).toString('base64'),
  });
  const crypto = new ClinicalCryptoService(config);
  let p12: Buffer;
  let saved: any;
  let tx: any;
  let prisma: any;
  let sri: { ping: jest.Mock };
  let service: IssuerService;
  const dto = (overrides: Partial<SaveIssuerDto> = {}): SaveIssuerDto => ({
    ruc,
    legalName: 'Clínica Los Arrayanes S.A.',
    tradeName: 'Los Arrayanes',
    headOfficeAddress: 'Av. Amazonas N24-03, Quito',
    accountingRequired: true,
    rimpeRegime: 'NONE',
    environment: '1',
    ...overrides,
  });
  const point = (overrides: Partial<IssuerEmissionPointDto> = {}): IssuerEmissionPointDto => ({
    establishmentCode: '001',
    emissionPointCode: '002',
    establishmentAddress: 'Av. 6 de Diciembre, Quito',
    ...overrides,
  });

  beforeAll(() => {
    p12 = createTestP12({ ruc });
  }, 30000);

  beforeEach(() => {
    saved = {
      id: 'issuer',
      tenantId: tenant,
      ruc,
      legalName: 'Clínica',
      tradeName: null,
      headOfficeAddress: 'Quito',
      accountingRequired: false,
      specialTaxpayerCode: null,
      withholdingAgentCode: null,
      rimpeRegime: 'NONE',
      environment: '1',
      active: true,
      certificateEncrypted: null,
      certificatePasswordEncrypted: null,
      certificateSubject: null,
      certificateSerial: null,
      certificateValidTo: null,
      certificateSha256: null,
      certificateRucVerified: false,
      revision: 1,
      points: [],
      sequences: [],
    };
    tx = {
      invoicingIssuer: {
        findUnique: jest.fn(async () => saved),
        upsert: jest.fn(async ({ create, update }) => {
          saved = saved
            ? applyData(saved, update)
            : { id: 'issuer', revision: 1, points: [], sequences: [], ...create };
          return saved;
        }),
        update: jest.fn(async ({ data }) => (saved = applyData(saved, data))),
      },
      invoiceRequest: { count: jest.fn().mockResolvedValue(0) },
      branch: {
        findFirst: jest.fn(async ({ where }) => (where.tenantId === tenant ? where : null)),
      },
      branchEmissionPoint: {
        findFirst: jest.fn(async ({ where }) =>
          saved.points.find(
            (p: any) =>
              p.issuerId === where.issuerId &&
              p.establishmentCode === where.establishmentCode &&
              p.emissionPointCode === where.emissionPointCode &&
              p.branchId !== where.NOT.branchId,
          ),
        ),
        upsert: jest.fn(async ({ where, create, update }) => {
          const current = saved.points.find((p: any) => p.branchId === where.branchId);
          if (current) Object.assign(current, update);
          else saved.points.push({ ...create });
        }),
      },
      invoiceSequence: {
        findUnique: jest.fn(async ({ where }) => {
          const k = where.issuerId_establishmentCode_emissionPointCode_environment;
          return saved.sequences.find(
            (s: any) =>
              s.issuerId === k.issuerId &&
              s.establishmentCode === k.establishmentCode &&
              s.emissionPointCode === k.emissionPointCode &&
              s.environment === k.environment,
          );
        }),
        upsert: jest.fn(async ({ where, create, update }) => {
          const k = where.issuerId_establishmentCode_emissionPointCode_environment;
          const current = saved.sequences.find(
            (s: any) =>
              s.establishmentCode === k.establishmentCode &&
              s.emissionPointCode === k.emissionPointCode &&
              s.environment === k.environment,
          );
          if (current) Object.assign(current, update);
          else saved.sequences.push({ next: 1, ...create });
        }),
      },
      auditLog: { create: jest.fn() },
    };
    prisma = {
      invoicingIssuer: tx.invoicingIssuer,
      applyRlsContext: jest.fn(),
      $transaction: jest.fn(async (fn) => fn(tx)),
    };
    sri = { ping: jest.fn().mockResolvedValue(true) };
    service = new IssuerService(prisma, crypto, sri as any);
  });

  it('saves issuer data with an audit entry and bumps the revision', async () => {
    saved = null;
    const created = await service.save(tenant, actor, dto());
    expect(created).toMatchObject({ ruc, environment: '1', revision: 1, certificate: null });
    const updated = await service.save(tenant, actor, dto({ legalName: 'Otra', revision: 1 }));
    expect(updated).toMatchObject({ legalName: 'Otra', tradeName: 'Los Arrayanes', revision: 2 });
    expect(tx.invoicingIssuer.upsert.mock.calls[1][0].update.revision).toEqual({ increment: 1 });
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        tenantId: tenant,
        userId: actor,
        changes: expect.objectContaining({ operation: 'ISSUER_SAVED' }),
      }),
    });
  });

  it('refuses a stale revision', async () => {
    await expect(service.save(tenant, actor, dto({ revision: 7 }))).rejects.toMatchObject({
      response: { code: 'INVOICING_CONFIGURATION_CHANGED' },
    });
    expect(tx.invoicingIssuer.upsert).not.toHaveBeenCalled();
  });

  it('refuses the NEGOCIO_POPULAR RIMPE regime', async () => {
    await expect(
      service.save(tenant, actor, dto({ rimpeRegime: 'NEGOCIO_POPULAR' })),
    ).rejects.toMatchObject({ status: 422, response: { code: 'RIMPE_REGIME_UNSUPPORTED' } });
  });

  it('locks the RUC once the issuer has an invoice request', async () => {
    tx.invoiceRequest.count.mockResolvedValue(1);
    await expect(service.save(tenant, actor, dto({ ruc: '0912345678001' }))).rejects.toMatchObject({
      response: { code: 'INVOICING_IDENTITY_LOCKED' },
    });
    expect(tx.invoiceRequest.count).toHaveBeenCalledWith({ where: { issuerId: 'issuer' } });
    await expect(service.save(tenant, actor, dto({ legalName: 'Otra' }))).resolves.toMatchObject({
      legalName: 'Otra',
    });
  });

  it('refuses an environment change while requests are REQUESTED, PROCESSING or AUTHORIZED without artifacts', async () => {
    tx.invoiceRequest.count.mockResolvedValueOnce(1);
    await expect(service.save(tenant, actor, dto({ environment: '2' }))).rejects.toMatchObject({
      response: { code: 'INVOICING_ENVIRONMENT_BUSY' },
    });
    expect(tx.invoiceRequest.count).toHaveBeenCalledWith({
      where: {
        issuerId: 'issuer',
        OR: [
          { status: { in: ['REQUESTED', 'PROCESSING'] } },
          { status: 'AUTHORIZED', OR: [{ xmlStorageKey: null }, { rideStorageKey: null }] },
        ],
      },
    });
    await expect(service.save(tenant, actor, dto({ environment: '2' }))).resolves.toMatchObject({
      environment: '2',
    });
  });

  it('stores the certificate and password encrypted and returns only metadata', async () => {
    const view = await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    expect(view.certificate).toMatchObject({ rucVerified: true });
    const data = tx.invoicingIssuer.update.mock.calls[0][0].data;
    expect(data.certificateEncrypted).not.toContain('MII'); // never in clear
    expect(crypto.decryptBuffer(tenant, Buffer.from(data.certificateEncrypted, 'base64'))).toEqual(
      p12,
    );
    expect(data.certificatePasswordEncrypted).not.toContain('clave-prueba');
    expect(data.revision).toEqual({ increment: 1 });
    const audit = JSON.stringify(tx.auditLog.create.mock.calls);
    expect(audit).not.toContain('clave-prueba');
    expect(audit).toContain('CERTIFICATE_REPLACED');
    expect(audit).toContain(view.certificate!.sha256);
    expect(JSON.stringify(view)).not.toContain(data.certificateEncrypted);
    expect(JSON.stringify(view)).not.toContain('clave-prueba');
    expect(service.loadSigningMaterial(saved).sha256).toBe(view.certificate!.sha256);
  });

  it('rejects a certificate of another RUC', async () => {
    saved.ruc = '0912345678001';
    await expect(service.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toMatchObject(
      { status: 422, response: { code: 'CERTIFICATE_RUC_MISMATCH' } },
    );
    expect(tx.invoicingIssuer.update).not.toHaveBeenCalled();
  });

  it('answers 422 with the certificate code when the password is wrong', async () => {
    await expect(service.saveCertificate(tenant, actor, p12, 'otra')).rejects.toMatchObject({
      status: 422,
      response: { code: 'CERTIFICATE_PASSWORD_INVALID' },
    });
  });

  it('requires the issuer data before the certificate', async () => {
    saved = null;
    await expect(service.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toMatchObject(
      { status: 422, response: { code: 'INVOICING_NOT_CONFIGURED' } },
    );
  });

  it('rejects certificates without encryption configured', async () => {
    const plain = new IssuerService(
      prisma,
      new ClinicalCipher() as ClinicalCryptoService,
      sri as any,
    );
    await expect(plain.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toMatchObject({
      status: 503,
      response: { code: 'INVOICING_ENCRYPTION_REQUIRED' },
    });
  });

  it('marks the certificate unverified when the RUC changes to one it does not name', async () => {
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    const view = await service.save(tenant, actor, dto({ ruc: '0912345678001' }));
    expect(view.certificate).toMatchObject({ rucVerified: false });
    const back = await service.save(tenant, actor, dto());
    expect(back.certificate).toMatchObject({ rucVerified: true });
  });

  it('creates the point and its sequence; the next sequential only moves up', async () => {
    const created = await service.setPoint(tenant, actor, 'branch', point({ nextSequential: 500 }));
    expect(created).toEqual({
      branchId: 'branch',
      establishmentCode: '001',
      emissionPointCode: '002',
      establishmentAddress: 'Av. 6 de Diciembre, Quito',
      nextSequential: 500,
    });
    expect(tx.invoiceSequence.upsert).toHaveBeenCalledWith({
      where: {
        issuerId_establishmentCode_emissionPointCode_environment: {
          issuerId: 'issuer',
          establishmentCode: '001',
          emissionPointCode: '002',
          environment: '1',
        },
      },
      create: {
        issuerId: 'issuer',
        establishmentCode: '001',
        emissionPointCode: '002',
        environment: '1',
        next: 500,
      },
      update: { next: 500 },
    });
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        changes: expect.objectContaining({ operation: 'EMISSION_POINT_SAVED' }),
      }),
    });
    await expect(
      service.setPoint(tenant, actor, 'branch', point({ nextSequential: 400 })),
    ).rejects.toMatchObject({ status: 409, response: { code: 'INVOICING_SEQUENCE_BACKWARDS' } });
    const unchanged = await service.setPoint(tenant, actor, 'branch', point());
    expect(unchanged.nextSequential).toBe(500);
  });

  it('starts a new series at 1', async () => {
    expect((await service.setPoint(tenant, actor, 'branch', point())).nextSequential).toBe(1);
  });

  it('refuses a series already assigned to another branch', async () => {
    await service.setPoint(tenant, actor, 'branch', point());
    await expect(service.setPoint(tenant, actor, 'other', point())).rejects.toMatchObject({
      status: 409,
      response: { code: 'INVOICING_SERIES_TAKEN' },
    });
  });

  it('refuses a branch of another clinic', async () => {
    tx.branch.findFirst.mockResolvedValueOnce(null);
    await expect(service.setPoint(tenant, actor, 'foreign', point())).rejects.toMatchObject({
      status: 404,
      response: { code: 'BRANCH_NOT_FOUND' },
    });
    expect(tx.branch.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign', tenantId: tenant },
    });
    expect(tx.branchEmissionPoint.upsert).not.toHaveBeenCalled();
  });

  it('requires the issuer before an emission point', async () => {
    saved = null;
    await expect(service.setPoint(tenant, actor, 'branch', point())).rejects.toMatchObject({
      status: 422,
      response: { code: 'INVOICING_NOT_CONFIGURED' },
    });
  });

  it('reports certificate and SRI reachability in test()', async () => {
    sri.ping.mockResolvedValueOnce(false);
    await expect(service.test(tenant)).resolves.toEqual({
      certificateValid: false,
      certificateError: 'INVOICING_CERTIFICATE_REQUIRED',
      rucVerified: false,
      sriReachable: false,
    });
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    await expect(service.test(tenant)).resolves.toEqual({
      certificateValid: true,
      certificateError: null,
      rucVerified: true,
      sriReachable: true,
    });
    expect(sri.ping).toHaveBeenLastCalledWith('1');
  });

  it('validates the issuer and emission point payloads', () => {
    const errors = (cls: any, body: object) =>
      validateSync(plainToInstance(cls, body)).map((e) => e.property);
    expect(errors(SaveIssuerDto, dto())).toEqual([]);
    expect(errors(SaveIssuerDto, dto({ ruc: '1790012345002' }))).toEqual(['ruc']);
    expect(errors(SaveIssuerDto, dto({ environment: '3' as any }))).toEqual(['environment']);
    expect(errors(SaveIssuerDto, dto({ specialTaxpayerCode: '12' }))).toEqual([
      'specialTaxpayerCode',
    ]);
    expect(errors(IssuerEmissionPointDto, point())).toEqual([]);
    expect(errors(IssuerEmissionPointDto, point({ establishmentCode: '000' }))).toEqual([
      'establishmentCode',
    ]);
    expect(errors(IssuerEmissionPointDto, point({ emissionPointCode: '1' }))).toEqual([
      'emissionPointCode',
    ]);
    expect(errors(IssuerEmissionPointDto, point({ nextSequential: 1000000000 }))).toEqual([
      'nextSequential',
    ]);
  });
});
