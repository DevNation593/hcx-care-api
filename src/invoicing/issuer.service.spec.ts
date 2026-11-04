import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createHash } from 'crypto';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { IssuerEmissionPointDto, SaveIssuerDto } from './dto/issuer.dto';
import { IssuerService } from './issuer.service';
import { createTestP12 } from './sri/testing/test-certificate';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function memoryStorage(log: string[] = []) {
  const files = new Map<string, Buffer>();
  return {
    files,
    put: jest.fn(async (key: string, data: Buffer) => {
      log.push(`put ${key}`);
      files.set(key, data);
    }),
    get: jest.fn(async (key: string) => {
      const data = files.get(key);
      if (!data) throw new Error('not found');
      return data;
    }),
    remove: jest.fn(async (key: string) => {
      log.push(`remove ${key}`);
      files.delete(key);
    }),
  };
}

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
  let log: string[];
  let storage: ReturnType<typeof memoryStorage>;
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
      certificateStorageKey: null,
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
        findFirst: jest.fn(async ({ where }) =>
          saved?.tenantId === where.tenantId &&
          saved.certificateStorageKey === where.certificateStorageKey
            ? { id: saved.id }
            : null,
        ),
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
    log = [];
    prisma = {
      invoicingIssuer: tx.invoicingIssuer,
      applyRlsContext: jest.fn(),
      $transaction: jest.fn(async (fn) => {
        const result = await fn(tx);
        log.push('commit');
        return result;
      }),
    };
    storage = memoryStorage(log);
    sri = { ping: jest.fn().mockResolvedValue(true) };
    service = new IssuerService(prisma, crypto, storage, sri as any);
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

  it('refuses a RUC whose check digit is wrong', async () => {
    await expect(service.save(tenant, actor, dto({ ruc: '0912345678001' }))).rejects.toMatchObject({
      status: 422,
      response: { code: 'INVOICING_RUC_INVALID' },
    });
    expect(tx.invoicingIssuer.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['a natural person', '0912345675001'],
    ['a company', '1790012345001'],
  ])('accepts the valid RUC of %s', async (_kind, valid) => {
    await expect(service.save(tenant, actor, dto({ ruc: valid }))).resolves.toMatchObject({
      ruc: valid,
    });
  });

  it('refuses the NEGOCIO_POPULAR RIMPE regime', async () => {
    await expect(
      service.save(tenant, actor, dto({ rimpeRegime: 'NEGOCIO_POPULAR' })),
    ).rejects.toMatchObject({ status: 422, response: { code: 'RIMPE_REGIME_UNSUPPORTED' } });
  });

  it('locks the RUC once the issuer has an invoice request', async () => {
    tx.invoiceRequest.count.mockResolvedValue(1);
    await expect(service.save(tenant, actor, dto({ ruc: '0912345675001' }))).rejects.toMatchObject({
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

  it('stores the certificate encrypted in file storage, not in the database, and returns only metadata', async () => {
    const view = await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    expect(view.certificate).toMatchObject({ rucVerified: true, sha256: sha256(p12) });
    const data = tx.invoicingIssuer.update.mock.calls[0][0].data;
    expect(data.certificateStorageKey).toMatch(
      /^invoicing-issuers\/clinic\/issuer\/certificate-[0-9a-f-]{36}$/,
    );
    expect(Object.values(data).some((v) => Buffer.isBuffer(v))).toBe(false);
    expect(JSON.stringify(data)).not.toContain(p12.toString('base64').slice(0, 40));
    const file = storage.files.get(data.certificateStorageKey)!;
    expect(file.includes(p12.subarray(0, 64))).toBe(false); // never in clear
    expect(crypto.decryptBuffer(tenant, file)).toEqual(p12);
    expect(data.certificateSha256).toBe(sha256(p12));
    expect(data.certificatePasswordEncrypted).not.toContain('clave-prueba');
    expect(data.revision).toEqual({ increment: 1 });
    const audit = JSON.stringify(tx.auditLog.create.mock.calls);
    expect(audit).not.toContain('clave-prueba');
    expect(audit).not.toContain(data.certificateStorageKey);
    expect(audit).toContain('CERTIFICATE_REPLACED');
    expect(audit).toContain(view.certificate!.sha256);
    expect(JSON.stringify(view)).not.toContain(data.certificateStorageKey);
    expect(JSON.stringify(view)).not.toContain('clave-prueba');
    expect((await service.loadSigningMaterial(saved)).subject).toBe(view.certificate!.subject);
  });

  it('removes the previous certificate file only after the replacement commits', async () => {
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    const first = saved.certificateStorageKey;
    log.length = 0;
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    const second = saved.certificateStorageKey;
    expect(second).not.toBe(first);
    expect(log).toEqual([`put ${second}`, 'commit', `remove ${first}`]);
    expect([...storage.files.keys()]).toEqual([second]);
    expect(JSON.stringify(tx.auditLog.create.mock.calls.at(-1))).toContain(
      `"previousSha256":"${sha256(p12)}"`,
    );
  });

  it('keeps the replacement when the previous file cannot be removed', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    const first = saved.certificateStorageKey;
    storage.remove.mockRejectedValueOnce(new Error('bucket down'));
    const view = await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    expect(view.certificate).not.toBeNull();
    expect(saved.certificateStorageKey).not.toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(first);
    expect(String(warn.mock.calls[0][0])).not.toContain('bucket down');
    warn.mockRestore();
  });

  it('removes the new file when the transaction fails and keeps the current certificate', async () => {
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    const first = saved.certificateStorageKey;
    prisma.$transaction.mockImplementationOnce(async () => {
      throw new Error('could not serialize');
    });
    await expect(service.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toThrow(
      'could not serialize',
    );
    expect(saved.certificateStorageKey).toBe(first);
    expect([...storage.files.keys()]).toEqual([first]);
  });

  it('removes the new file when the configuration changed meanwhile', async () => {
    tx.invoicingIssuer.findUnique.mockImplementationOnce(async () => saved);
    tx.invoicingIssuer.findUnique.mockImplementationOnce(async () => ({ ...saved, revision: 9 }));
    await expect(service.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toMatchObject(
      { response: { code: 'INVOICING_CONFIGURATION_CHANGED' } },
    );
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(storage.files.size).toBe(0);
  });

  it('keeps the new file when a failed commit may have committed', async () => {
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    const first = saved.certificateStorageKey;
    prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      await fn(tx);
      throw new Error('connection lost during COMMIT');
    });
    await expect(service.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toThrow(
      'connection lost',
    );
    const second = saved.certificateStorageKey;
    expect(second).not.toBe(first);
    expect(storage.files.has(second)).toBe(true);
    // Unknown outcome: the lookup that would prove it unused failed too, so nothing is removed.
    prisma.$transaction.mockImplementationOnce(async () => {
      throw new Error('connection lost');
    });
    tx.invoicingIssuer.findFirst.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toThrow();
    expect(storage.files.size).toBe(3);
  });

  it('answers 503 and keeps the certificate when the file cannot be stored', async () => {
    storage.put.mockRejectedValueOnce(new Error('bucket down'));
    await expect(service.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toMatchObject(
      { status: 503, response: { code: 'INVOICING_CERTIFICATE_UNAVAILABLE' } },
    );
    expect(tx.invoicingIssuer.update).not.toHaveBeenCalled();
  });

  it('refuses a stored certificate whose bytes changed', async () => {
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    const other = createTestP12({ ruc });
    storage.files.set(saved.certificateStorageKey, crypto.encryptBuffer(tenant, other));
    await expect(service.loadSigningMaterial(saved)).rejects.toMatchObject({
      kind: 'configuration',
      code: 'CERTIFICATE_INTEGRITY',
    });
    storage.files.set(saved.certificateStorageKey, Buffer.from('not encrypted'));
    await expect(service.loadSigningMaterial(saved)).rejects.toMatchObject({
      kind: 'configuration',
      code: 'CERTIFICATE_INTEGRITY',
    });
  }, 30000);

  it('treats an unreadable certificate file as transient', async () => {
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    storage.get.mockRejectedValueOnce(new Error('bucket down'));
    await expect(service.loadSigningMaterial(saved)).rejects.toMatchObject({
      kind: 'transient',
      code: 'INVOICING_CERTIFICATE_UNAVAILABLE',
    });
    storage.get.mockRejectedValueOnce(new Error('bucket down'));
    await expect(service.test(tenant)).resolves.toMatchObject({
      certificateValid: false,
      certificateError: 'INVOICING_CERTIFICATE_UNAVAILABLE',
    });
  });

  it('refuses a RUC change while the certificate cannot be read to check it', async () => {
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    storage.get.mockRejectedValueOnce(new Error('bucket down'));
    await expect(service.save(tenant, actor, dto({ ruc: '0912345675001' }))).rejects.toMatchObject({
      status: 503,
      response: { code: 'INVOICING_CERTIFICATE_UNAVAILABLE' },
    });
    expect(tx.invoicingIssuer.upsert).not.toHaveBeenCalled();
  });

  it('rejects a certificate of another RUC', async () => {
    saved.ruc = '0912345675001';
    await expect(service.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toMatchObject(
      { status: 422, response: { code: 'CERTIFICATE_RUC_MISMATCH' } },
    );
    expect(tx.invoicingIssuer.update).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('answers 422 with the certificate code when the password is wrong', async () => {
    await expect(service.saveCertificate(tenant, actor, p12, 'otra')).rejects.toMatchObject({
      status: 422,
      response: { code: 'CERTIFICATE_PASSWORD_INVALID' },
    });
    expect(storage.put).not.toHaveBeenCalled();
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
      storage,
      sri as any,
    );
    await expect(plain.saveCertificate(tenant, actor, p12, 'clave-prueba')).rejects.toMatchObject({
      status: 503,
      response: { code: 'INVOICING_ENCRYPTION_REQUIRED' },
    });
  });

  it('marks the certificate unverified when the RUC changes to one it does not name', async () => {
    await service.saveCertificate(tenant, actor, p12, 'clave-prueba');
    const view = await service.save(tenant, actor, dto({ ruc: '0912345675001' }));
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
