import { ConfigService } from '@nestjs/config';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { ConnectionService } from './connection.service';

describe('validated invoicing connection', () => {
  const tenant = 'clinic';
  const config = new ConfigService({
    CLINICAL_ENCRYPTION_KEYS: 'test:' + Buffer.alloc(32, 7).toString('base64'),
  });
  const crypto = new ClinicalCryptoService(config);
  const taxpayer = {
    id: 'issuer',
    legalName: 'Empresa',
    ruc: '1790012345001',
    defaultEnvironment: '1',
  };
  let saved: any;
  let tx: any;
  let prisma: any;
  let client: any;
  let provider: any;
  let service: ConnectionService;
  beforeEach(() => {
    saved = {
      id: 'connection',
      tenantId: tenant,
      revision: 1,
      apiKeyEncrypted: crypto.encrypt(tenant, 'old-key'),
      externalTenantId: 'company',
      taxpayerId: 'issuer',
      environment: '1',
      points: [],
    };
    tx = {
      invoicingConnection: {
        findUnique: jest.fn(async () => saved),
        upsert: jest.fn(async () => saved),
      },
      invoiceRequest: { count: jest.fn().mockResolvedValue(0) },
      branchEmissionPoint: { deleteMany: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    prisma = {
      invoicingConnection: tx.invoicingConnection,
      applyRlsContext: jest.fn(),
      $transaction: jest.fn(async (fn) => fn(tx)),
    };
    client = {
      getTenant: jest.fn().mockResolvedValue({ id: 'company', status: 'ACTIVE' }),
      listTaxpayers: jest.fn().mockResolvedValue([taxpayer]),
    };
    provider = { client: jest.fn(() => client) };
    service = new ConnectionService(prisma, crypto, provider, config);
  });
  it('rejects saving omitted credentials if the tested key was rotated concurrently', async () => {
    client.listTaxpayers.mockImplementation(async () => {
      saved = { ...saved, revision: 2, apiKeyEncrypted: crypto.encrypt(tenant, 'new-key') };
      return [taxpayer];
    });
    await expect(service.save(tenant, 'actor', { taxpayerId: 'issuer' })).rejects.toMatchObject({
      response: { code: 'INVOICING_CONFIGURATION_CHANGED' },
    });
    expect(tx.invoicingConnection.upsert).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    '/relative',
    'invalid',
    'ftp://example.com',
    'https://user:password@example.com',
  ])('does not advertise a webhook URL for invalid public base %s', async (base) => {
    const connection = new ConnectionService(
      prisma,
      crypto,
      provider,
      new ConfigService({ BACKEND_PUBLIC_URL: base }),
    );
    expect((await connection.get(tenant))!.webhookUrl).toBeNull();
  });
  it('advertises an absolute webhook URL using the configured prefix', async () => {
    const connection = new ConnectionService(
      prisma,
      crypto,
      provider,
      new ConfigService({ BACKEND_PUBLIC_URL: 'https://api.example.com/', API_PREFIX: '/api/v1/' }),
    );
    expect((await connection.get(tenant))!.webhookUrl).toBe(
      'https://api.example.com/api/v1/integrations/emite-facil/webhook/connection',
    );
  });
  it('preserves tested omitted credentials and never exposes them', async () => {
    await service.save(tenant, 'actor', { taxpayerId: 'issuer' });
    expect(provider.client).toHaveBeenCalledWith('old-key');
    expect(tx.invoicingConnection.upsert.mock.calls[0][0].update.apiKeyEncrypted).toBe(
      saved.apiKeyEncrypted,
    );
    expect(JSON.stringify(await service.get(tenant))).not.toContain('old-key');
  });
  it('locks company identity after the first request but permits key rotation', async () => {
    tx.invoiceRequest.count.mockResolvedValue(1);
    client.getTenant.mockResolvedValueOnce({ id: 'other', status: 'ACTIVE' });
    await expect(
      service.save(tenant, 'actor', { taxpayerId: 'issuer', apiKey: 'rotated' }),
    ).rejects.toMatchObject({ response: { code: 'INVOICING_IDENTITY_LOCKED' } });
    await expect(
      service.save(tenant, 'actor', { taxpayerId: 'issuer', apiKey: 'rotated' }),
    ).resolves.toBeDefined();
  });
  it('allows a same-issuer environment switch only without unresolved work', async () => {
    client.listTaxpayers.mockResolvedValue([{ ...taxpayer, defaultEnvironment: '2' }]);
    tx.invoiceRequest.count.mockResolvedValueOnce(1);
    await expect(service.save(tenant, 'actor', { taxpayerId: 'issuer' })).rejects.toMatchObject({
      response: { code: 'INVOICING_ENVIRONMENT_BUSY' },
    });
    await expect(service.save(tenant, 'actor', { taxpayerId: 'issuer' })).resolves.toBeDefined();
  });
});
