import { Prisma, TenantSubscription } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma/prisma.service';
import { SpecialtyCatalogService } from './specialty-catalog.service';
import { TenantSpecialtiesService } from './tenant-specialties.service';

describe('TenantSpecialtiesService', () => {
  const psy = {
    id: 'psy',
    code: 'PSYCHOLOGY',
    name: 'Psicología',
    description: null,
    modules: [
      { id: 'p', moduleKey: 'psychology.notes' },
      { id: 's1', moduleKey: 'shared' },
    ],
  };
  const nut = {
    id: 'nut',
    code: 'NUTRITION',
    name: 'Nutrición',
    description: null,
    modules: [
      { id: 'n', moduleKey: 'nutrition.assessment' },
      { id: 's2', moduleKey: 'shared' },
    ],
  };
  let tx: any;
  let db: any;
  let service: TenantSpecialtiesService;
  let selected: string[];
  let billed: string[];
  let modules: { moduleKey: string; enabled: boolean }[];
  let subscription: TenantSubscription;

  beforeEach(() => {
    selected = ['psy'];
    billed = ['obsolete'];
    modules = [
      { moduleKey: 'psychology.notes', enabled: false },
      { moduleKey: 'obsolete', enabled: true },
    ];
    subscription = {
      id: 'sub-1',
      tenantId: 'tenant-1',
      planId: 'plan_personal_basic',
      currency: 'USD',
      specialtyPrice: new Decimal(15),
      basePrice: new Decimal(25),
      includedSpecialties: 1,
    } as TenantSubscription;
    const joins = (read: () => string[], write: (ids: string[]) => void) => ({
      findMany: jest.fn(async () => read().map((specialtyId) => ({ specialtyId }))),
      createMany: jest.fn(async ({ data }) => {
        write([...read(), ...data.map((row) => row.specialtyId)]);
      }),
      deleteMany: jest.fn(async ({ where }) => {
        write(read().filter((id) => !where.specialtyId.in.includes(id)));
      }),
    });
    tx = {
      specialty: {
        findMany: jest.fn(async ({ where }) =>
          [psy, nut].filter((row) => where.code.in.includes(row.code)),
        ),
      },
      specialtyModule: {
        findMany: jest.fn(async ({ where }) =>
          where.moduleKey.in
            .filter((key: string) =>
              ['psychology.notes', 'nutrition.assessment', 'shared', 'obsolete'].includes(key),
            )
            .map((moduleKey: string) => ({ moduleKey })),
        ),
      },
      tenantSpecialty: {
        ...joins(
          () => selected,
          (ids) => {
            selected = ids;
          },
        ),
        findFirst: jest.fn().mockResolvedValue({ specialtyId: 'nut' }),
      },
      subscriptionSpecialty: joins(
        () => billed,
        (ids) => {
          billed = ids;
        },
      ),
      tenantModule: {
        findMany: jest.fn(async () =>
          [...modules].sort((a, b) => a.moduleKey.localeCompare(b.moduleKey)),
        ),
        createMany: jest.fn(async ({ data }) => {
          modules.push(...data.map(({ moduleKey, enabled }) => ({ moduleKey, enabled })));
        }),
        deleteMany: jest.fn(async ({ where }) => {
          modules = modules.filter((row) => !where.moduleKey.in.includes(row.moduleKey));
        }),
        findUnique: jest.fn().mockResolvedValue({ id: 'module-1', enabled: true }),
        create: jest.fn(async ({ data }) => data),
        update: jest.fn(async ({ data }) => ({ id: 'module-1', ...data })),
      },
      tenantSubscription: {
        findUnique: jest.fn(async () => subscription),
        update: jest.fn(async ({ data }) => Object.assign(subscription, data)),
      },
      auditLog: { create: jest.fn() },
      professionalProfile: { findFirst: jest.fn().mockResolvedValue(null), deleteMany: jest.fn() },
      appointment: { findFirst: jest.fn().mockResolvedValue(null), deleteMany: jest.fn() },
      clinicalNote: { deleteMany: jest.fn() },
      specialtyRecord: { deleteMany: jest.fn() },
    };
    db = { $transaction: jest.fn(async (callback) => callback(tx)), applyRlsContext: jest.fn() };
    service = new TenantSpecialtiesService(
      db as PrismaService,
      new SpecialtyCatalogService(db as PrismaService),
    );
  });

  it('normalizes, preserves request order, deduplicates joins/modules and prices absolutely', async () => {
    const first = await service.replace(
      'tenant-1',
      [' nutrition ', 'PSYCHOLOGY', 'NUTRITION'],
      'admin-1',
    );
    expect(first).toEqual({
      tenantId: 'tenant-1',
      specialties: [nut, psy],
      modules: [
        { moduleKey: 'nutrition.assessment', enabled: true },
        { moduleKey: 'psychology.notes', enabled: false },
        { moduleKey: 'shared', enabled: true },
      ],
      pricing: {
        includedSpecialties: 1,
        selectedSpecialties: 2,
        billableSpecialties: 1,
        specialtyUnitPrice: 15,
        basePlanPrice: 25,
        specialtyAddonsPrice: 15,
        totalMonthly: 40,
        currency: 'USD',
      },
    });
    expect(selected.sort()).toEqual(['nut', 'psy']);
    expect(billed.sort()).toEqual(['nut', 'psy']);
    // The plan price stays; the extra specialty is added when charging.
    expect(subscription.basePrice.toNumber()).toBe(25);
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(db.applyRlsContext).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      userId: 'admin-1',
    });
    expect(tx.specialty.findMany).toHaveBeenCalledWith({
      where: { code: { in: ['NUTRITION', 'PSYCHOLOGY'] }, isActive: true },
      include: { modules: { orderBy: { moduleKey: 'asc' } } },
    });

    jest.clearAllMocks();
    expect(await service.replace('tenant-1', ['NUTRITION', 'PSYCHOLOGY'], 'admin-1')).toEqual(
      first,
    );
    for (const delegate of [tx.tenantSpecialty, tx.subscriptionSpecialty, tx.tenantModule]) {
      expect(delegate.createMany).not.toHaveBeenCalled();
      expect(delegate.deleteMany).not.toHaveBeenCalled();
    }
  });

  it('audits specialty, module and price changes with the platform actor in the same transaction', async () => {
    await service.replace('tenant-1', ['NUTRITION'], 'admin-1');

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        userId: 'admin-1',
        action: 'UPDATE',
        entity: 'TENANT',
        entityId: 'tenant-1',
        changes: {
          before: {
            specialtyIds: ['psy'],
            modules: [
              { moduleKey: 'obsolete', enabled: true },
              { moduleKey: 'psychology.notes', enabled: false },
            ],
            monthlyPrice: 25,
          },
          after: {
            specialtyIds: ['nut'],
            modules: [
              { moduleKey: 'nutrition.assessment', enabled: true },
              { moduleKey: 'shared', enabled: true },
            ],
            monthlyPrice: 25,
          },
        },
      },
    });
  });

  it('blocks removal used by an effective active professional before any mutation', async () => {
    tx.professionalProfile.findFirst.mockResolvedValue({ userId: 'professional-1' });
    await expect(service.replace('tenant-1', ['NUTRITION'], 'admin-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'SPECIALTY_IN_USE_BY_ACTIVE_PROFESSIONAL' },
    });
    expect(tx.professionalProfile.findFirst).toHaveBeenCalledWith({
      where: { specialtyId: 'psy', isActive: true, user: { tenantId: 'tenant-1', isActive: true } },
      select: { userId: true },
    });
    expect(tx.tenantSpecialty.deleteMany).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
  });

  it('blocks future non-cancelled appointments with tenant-scoped dependencies', async () => {
    tx.appointment.findFirst.mockResolvedValue({ id: 'future' });
    await expect(service.replace('tenant-1', ['NUTRITION'], 'admin-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'SPECIALTY_HAS_FUTURE_APPOINTMENTS' },
    });
    expect(tx.appointment.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        specialtyId: 'psy',
        startTime: { gt: expect.any(Date) },
        status: { not: 'CANCELLED' },
      },
      select: { id: true },
    });
    expect(tx.tenantSpecialty.deleteMany).not.toHaveBeenCalled();
  });

  it('reconciles when dependency queries find none and retains clinical data', async () => {
    await service.replace('tenant-1', ['NUTRITION'], 'admin-1');
    expect(selected).toEqual(['nut']);
    expect(billed).toEqual(['nut']);
    expect(modules).toEqual([
      { moduleKey: 'nutrition.assessment', enabled: true },
      { moduleKey: 'shared', enabled: true },
    ]);
    for (const delegate of [
      tx.professionalProfile,
      tx.appointment,
      tx.clinicalNote,
      tx.specialtyRecord,
    ])
      expect(delegate.deleteMany).not.toHaveBeenCalled();
    expect(tx.tenantSpecialty.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', specialtyId: { in: ['psy'] } },
    });
    expect(tx.subscriptionSpecialty.deleteMany).toHaveBeenCalledWith({
      where: { tenantSubscriptionId: 'sub-1', specialtyId: { in: ['obsolete'] } },
    });
    expect(tx.tenantModule.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', moduleKey: { in: ['obsolete', 'psychology.notes'] } },
    });
  });

  it('keeps disabled core and other tenant-owned modules outside the specialty catalog', async () => {
    modules.push(
      { moduleKey: 'core.clinicalNotes', enabled: false },
      { moduleKey: 'commercial.export', enabled: false },
    );

    const result = await service.replace('tenant-1', ['NUTRITION'], 'admin-1');

    expect(modules).toEqual([
      { moduleKey: 'core.clinicalNotes', enabled: false },
      { moduleKey: 'commercial.export', enabled: false },
      { moduleKey: 'nutrition.assessment', enabled: true },
      { moduleKey: 'shared', enabled: true },
    ]);
    expect(result.modules).toEqual([
      { moduleKey: 'commercial.export', enabled: false },
      { moduleKey: 'core.clinicalNotes', enabled: false },
      { moduleKey: 'nutrition.assessment', enabled: true },
      { moduleKey: 'shared', enabled: true },
    ]);
    expect(tx.tenantModule.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', moduleKey: { in: ['obsolete', 'psychology.notes'] } },
    });
    expect(tx.tenantModule.createMany).toHaveBeenCalledWith({
      data: [
        { tenantId: 'tenant-1', moduleKey: 'nutrition.assessment', enabled: true },
        { tenantId: 'tenant-1', moduleKey: 'shared', enabled: true },
      ],
    });
    expect(tx.specialtyModule.findMany).toHaveBeenCalledWith({
      where: {
        moduleKey: {
          in: ['commercial.export', 'core.clinicalNotes', 'obsolete', 'psychology.notes'],
        },
      },
      select: { moduleKey: true },
    });
  });

  it('rejects changing a core.* key with SECTION_MANAGED_BY_PLATFORM', async () => {
    await expect(
      service.updateModule('tenant-1', 'core.tasks', false, 'master-1'),
    ).rejects.toMatchObject({
      status: 403,
      response: { statusCode: 403, code: 'SECTION_MANAGED_BY_PLATFORM' },
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.tenantModule.findUnique).not.toHaveBeenCalled();
    expect(tx.tenantModule.create).not.toHaveBeenCalled();
    expect(tx.tenantModule.update).not.toHaveBeenCalled();
  });

  it('never deletes or creates core.* rows when the specialty selection changes', async () => {
    // A catalog that (wrongly) lists core.* keys must not let a selection touch them.
    const catalogOwned = ['psychology.notes', 'nutrition.assessment', 'shared', 'obsolete'];
    tx.specialtyModule.findMany.mockImplementation(async ({ where }) =>
      where.moduleKey.in
        .filter((key: string) => [...catalogOwned, 'core.billing'].includes(key))
        .map((moduleKey: string) => ({ moduleKey })),
    );
    nut.modules.push({ id: 'c', moduleKey: 'core.storage' });
    modules.push({ moduleKey: 'core.billing', enabled: true });
    try {
      await service.replace('tenant-1', ['NUTRITION'], 'admin-1');
    } finally {
      nut.modules.pop();
    }

    expect(modules.map(({ moduleKey }) => moduleKey)).toContain('core.billing');
    expect(modules.map(({ moduleKey }) => moduleKey)).not.toContain('core.storage');
    for (const call of tx.tenantModule.deleteMany.mock.calls)
      expect(call[0].where.moduleKey.in.some((key: string) => key.startsWith('core.'))).toBe(false);
    for (const call of tx.tenantModule.createMany.mock.calls)
      expect(call[0].data.some(({ moduleKey }) => moduleKey.startsWith('core.'))).toBe(false);
  });

  it('recreates removed specialty modules enabled when the specialty returns', async () => {
    await service.replace('tenant-1', ['NUTRITION'], 'admin-1');
    const result = await service.replace('tenant-1', ['PSYCHOLOGY'], 'admin-1');
    expect(result.modules).toEqual([
      { moduleKey: 'psychology.notes', enabled: true },
      { moduleKey: 'shared', enabled: true },
    ]);
  });

  it.each([[[]], [[' ']], [['UNKNOWN']]])(
    'rejects unavailable or empty selection %j without writing',
    async (codes) => {
      await expect(service.replace('tenant-1', codes, 'admin-1')).rejects.toMatchObject({
        response: {
          code: codes[0] === 'UNKNOWN' ? 'SPECIALTY_NOT_AVAILABLE' : 'SPECIALTY_SELECTION_REQUIRED',
        },
      });
      expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    },
  );

  it('fails on missing subscription without creating partial state', async () => {
    tx.tenantSubscription.findUnique.mockResolvedValue(null);
    await expect(service.replace('tenant-1', ['PSYCHOLOGY'], 'admin-1')).rejects.toMatchObject({
      status: 404,
    });
    expect(tx.tenantSpecialty.createMany).not.toHaveBeenCalled();
  });

  it('retries serialization conflicts with a fresh RLS context and stops after three attempts', async () => {
    tx.tenantSubscription.findUnique.mockRejectedValueOnce({ code: 'P2034' });
    await service.replace('tenant-1', ['PSYCHOLOGY'], 'admin-1');
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.applyRlsContext).toHaveBeenCalledTimes(2);
    jest.clearAllMocks();
    tx.tenantSubscription.findUnique.mockRejectedValue({ code: 'P2034' });
    await expect(service.replace('tenant-1', ['PSYCHOLOGY'], 'admin-1')).rejects.toEqual({
      code: 'P2034',
    });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });

  it('applySelection uses the supplied transaction without nesting for onboarding', async () => {
    selected = [];
    billed = [];
    modules = [];
    const result = await service.applySelection(tx, {
      tenantId: 'tenant-1',
      subscription,
      specialties: [psy],
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(result.pricing.totalMonthly).toBe(25);
    expect(selected).toEqual(['psy']);
    expect(billed).toEqual(['psy']);
  });

  it('does not let onboarding clear the last specialty through applySelection', async () => {
    await expect(
      service.applySelection(tx, { tenantId: 'tenant-1', subscription, specialties: [] }),
    ).rejects.toMatchObject({ status: 400, response: { code: 'SPECIALTY_SELECTION_REQUIRED' } });
    expect(tx.tenantSpecialty.deleteMany).not.toHaveBeenCalled();
    expect(tx.subscriptionSpecialty.deleteMany).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'rejects unowned or inactive-specialty module changes (%s)',
    async (enabled) => {
      tx.tenantSpecialty.findFirst.mockResolvedValue(null);
      await expect(
        service.updateModule('tenant-1', 'nutrition.assessment', enabled, 'admin-1'),
      ).rejects.toMatchObject({ status: 409, response: { code: 'MODULE_SPECIALTY_NOT_ENABLED' } });
      expect(tx.tenantSpecialty.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-1',
          specialty: { isActive: true, modules: { some: { moduleKey: 'nutrition.assessment' } } },
        },
        select: { specialtyId: true },
      });
      expect(tx.tenantModule.create).not.toHaveBeenCalled();
      expect(tx.tenantModule.update).not.toHaveBeenCalled();
    },
  );

  it('enables a missing owned module', async () => {
    tx.tenantModule.findUnique.mockResolvedValue(null);
    await expect(
      service.updateModule('tenant-1', 'nutrition.assessment', true, 'admin-1'),
    ).resolves.toMatchObject({
      tenantId: 'tenant-1',
      moduleKey: 'nutrition.assessment',
      enabled: true,
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        userId: 'admin-1',
        action: 'UPDATE',
        entity: 'TENANT',
        entityId: 'tenant-1',
        changes: {
          before: { module: { key: 'nutrition.assessment', enabled: null } },
          after: { module: { key: 'nutrition.assessment', enabled: true } },
        },
      },
    });
  });

  it('disables an existing owned module without changing price or clinical records', async () => {
    await expect(
      service.updateModule('tenant-1', 'nutrition.assessment', false, 'admin-1'),
    ).resolves.toMatchObject({ enabled: false });
    expect(tx.tenantModule.update).toHaveBeenCalledWith({
      where: { id: 'module-1' },
      data: { enabled: false },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        userId: 'admin-1',
        action: 'UPDATE',
        entity: 'TENANT',
        entityId: 'tenant-1',
        changes: {
          before: { module: { key: 'nutrition.assessment', enabled: true } },
          after: { module: { key: 'nutrition.assessment', enabled: false } },
        },
      },
    });
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
  });

  it('returns 404 when disabling a missing owned module', async () => {
    tx.tenantModule.findUnique.mockResolvedValue(null);
    await expect(
      service.updateModule('tenant-1', 'nutrition.assessment', false, 'admin-1'),
    ).rejects.toMatchObject({ status: 404 });
    expect(tx.tenantModule.create).not.toHaveBeenCalled();
  });
});
