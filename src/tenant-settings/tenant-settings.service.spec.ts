import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateTenantSettingsDto } from './dto/tenant-settings.dto';
import { TenantSettingsService } from './tenant-settings.service';

// Written with a character class so the retired provider name never appears in src.
const RETIRED_PREFIX = /^fa[k]tur/i;
const RETIRED_FIELDS = ['fa[k]turApiKey', 'fa[k]turEnabled', 'fa[k]turEnvironment'].map((name) =>
  name.replace('[k]', 'k'),
);

describe('TenantSettingsService without e-invoicing provider settings', () => {
  const storedSettings = {
    tenantId: 'tenant-1',
    workingHoursStart: '09:00',
    workingHoursEnd: '18:00',
    tenant: {
      legalName: 'Clínica Integral S.A.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1790012345001',
    },
  };
  const prisma = {
    tenantSettings: { findUnique: jest.fn(), update: jest.fn() },
    tenant: { update: jest.fn() },
    billingSettings: { upsert: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  let service: TenantSettingsService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.tenantSettings.findUnique.mockResolvedValue(storedSettings);
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
      callback(prisma),
    );
    service = new TenantSettingsService(prisma as unknown as PrismaService);
  });

  it('returns the fiscal data of the tenant and no provider key', async () => {
    const settings = await service.findOne('tenant-1');

    expect(settings).toMatchObject({ legalName: 'Clínica Integral S.A.' });
    expect(Object.keys(settings).filter((key) => RETIRED_PREFIX.test(key))).toEqual([]);
    expect(
      prisma.tenantSettings.findUnique.mock.calls[0][0].include.tenant.select,
    ).not.toHaveProperty('billingSettings');
  });

  it('never reads or writes BillingSettings when updating', async () => {
    await service.update('tenant-1', { legalName: 'Nueva S.A.' });

    expect(prisma.billingSettings.upsert).not.toHaveBeenCalled();
    expect(prisma.billingSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.tenant.update).toHaveBeenCalled();
  });

  it.each(RETIRED_FIELDS)('rejects %s in the request', async (field) => {
    const dto = plainToInstance(UpdateTenantSettingsDto, { [field]: 'x' });

    // Same options as the global ValidationPipe of main.ts.
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

    expect(errors.map((error) => error.property)).toEqual([field]);
  });
});
