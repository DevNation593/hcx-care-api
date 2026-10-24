import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpecialtyCatalogService } from '../specialties/specialty-catalog.service';
import { TenantSpecialtiesService } from '../specialties/tenant-specialties.service';
import { SECTION_KEYS } from '../common/sections/section-catalog';
import { CreatePlatformTenantDto } from './dto/create-platform-tenant.dto';
import { DEFAULT_PLANS } from '../plans/default-plans';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformPlansService } from './platform-plans.service';
import { PlatformTenantsService } from './platform-tenants.service';

const TEMP_PASSWORD = 'Temp-Pass-9876';
const psychology = {
  id: 'specialty-1',
  code: 'PSYCHOLOGY',
  name: 'Psicología',
  description: null,
  modules: [{ id: 'module-1', moduleKey: 'psychology.notes' }],
};
const aesthetics = {
  id: 'specialty-aesthetics',
  code: 'AESTHETICS',
  name: 'Estética',
  description: null,
  modules: [],
};

// The default plans as the migration stores them, by id.
const PLANS = new Map(
  DEFAULT_PLANS.map(({ modules, ...plan }) => {
    const id = `plan_${plan.code.toLowerCase()}`;
    return [
      id,
      {
        id,
        ...plan,
        basePrice: new Prisma.Decimal(plan.basePrice),
        pricePerSeat: new Prisma.Decimal(plan.pricePerSeat),
        specialtyPrice: new Prisma.Decimal(plan.specialtyPrice),
        currency: 'USD',
        archivedAt: null,
        modules: modules.map((moduleKey) => ({ moduleKey })),
      },
    ];
  }),
);
const findPlan = jest.fn(
  async ({ where }: { where: { id: string } }) => PLANS.get(where.id) ?? null,
);
const CODE_OF: Record<string, string> = {
  'specialty-1': 'PSYCHOLOGY',
  [aesthetics.id]: 'AESTHETICS',
};

function input(overrides: Partial<CreatePlatformTenantDto> = {}): CreatePlatformTenantDto {
  return {
    name: ' Clínica Centro ',
    email: ' CONTACT@EXAMPLE.COM ',
    phone: ' 555-111 ',
    address: ' Calle 1 ',
    tenantType: 'CLINIC',
    timezone: ' America/Guayaquil ',
    locale: ' es-EC ',
    masterFirstName: ' Ana ',
    masterLastName: ' Pérez ',
    masterEmail: ' ANA@EXAMPLE.COM ',
    temporaryPassword: TEMP_PASSWORD,
    planId: 'plan_clinic_basic',
    specialtyCodes: ['psychology'],
    ...overrides,
  };
}

const NOTES = ['core.patients', 'core.patients.records', 'core.clinical', 'core.clinical.notes'];
const CALENDAR = ['core.patients', 'core.patients.records', 'core.agenda', 'core.agenda.calendar'];

describe('PlatformTenantsService', () => {
  let state: {
    tenants: any[];
    settings: any[];
    subscriptions: any[];
    users: any[];
    modules: any[];
    events: any[];
    selections: string[];
    refreshTokens: any[];
  };
  let prisma: any;
  let listRows: any[];
  let audit: any;
  let catalog: any;
  let selection: any;
  let auth: any;
  let service: PlatformTenantsService;

  function readTenant(source: typeof state, id: string) {
    const tenant = source.tenants.find((t) => t.id === id && !t.isPlatform);
    if (!tenant) return null;
    const subscription = source.subscriptions.find((s) => s.tenantId === id);
    const master = source.users.find((u) => u.tenantId === id && u.role === 'MASTER');
    return {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
      phone: tenant.phone ?? null,
      address: tenant.address ?? null,
      tenantType: tenant.tenantType,
      isActive: tenant.isActive ?? true,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      subscription: subscription && {
        ...subscription,
        plan: (({ id: planId, code, name }) => ({ id: planId, code, name }))(
          PLANS.get(subscription.planId)!,
        ),
        _count: { specialties: source.selections.length },
        overriddenFields: subscription.overriddenFields ?? [],
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt ?? null,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd ?? null,
        seatsPsychologistsMax: subscription.seatsPsychologistsMax,
        seatsPsychologistsUsed: subscription.seatsPsychologistsUsed,
        maxActivePatients: subscription.maxActivePatients,
        activePatientsCount: 0,
        monthlyNotificationsSent: 0,
        basePrice: subscription.basePrice,
        currency: subscription.currency,
      },
      users: master
        ? [
            {
              id: master.id,
              firstName: master.firstName,
              lastName: master.lastName,
              email: master.email,
              mustChangePassword: master.mustChangePassword,
            },
          ]
        : [],
      specialties: source.selections.map(() => ({
        specialty: { id: psychology.id, code: psychology.code, name: psychology.name },
      })),
      enabledModules: source.modules
        .filter((m) => m.tenantId === id)
        .map((m) => ({ moduleKey: m.moduleKey, enabled: m.enabled, source: m.source })),
    };
  }

  beforeEach(() => {
    state = {
      tenants: [],
      settings: [],
      subscriptions: [],
      users: [],
      modules: [],
      events: [],
      selections: [],
      refreshTokens: [],
    };
    listRows = [];
    prisma = {
      plan: { findUnique: findPlan },
      tenant: {
        findFirst: jest.fn(async ({ where }) => readTenant(state, where.id)),
        findMany: jest.fn(async () => listRows),
        count: jest.fn(async () => listRows.length),
      },
      $transaction: jest.fn(async (callback, options) => {
        if (options !== undefined) {
          expect(options).toEqual({
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          });
        }
        const pending = structuredClone(state);
        const tx = {
          $executeRaw: jest.fn(async () => 1),
          plan: { findUnique: findPlan },
          user: {
            findFirst: jest.fn(async ({ where }) => {
              if (where.role === 'MASTER') {
                const master = pending.users.find(
                  (u) => u.tenantId === where.tenantId && u.role === 'MASTER',
                );
                // Like a real query, return a snapshot rather than the live row.
                return master ? { ...master } : null;
              }
              const filter = where.email;
              return (
                pending.users.find((u) =>
                  filter.mode === 'insensitive'
                    ? u.email.toLowerCase() === filter.equals.toLowerCase()
                    : u.email === filter.equals,
                ) ?? null
              );
            }),
            update: jest.fn(async ({ where, data }) => {
              const row = pending.users.find((u) => u.id === where.id);
              Object.assign(row, data);
              return row;
            }),
            create: jest.fn(async ({ data, select }) => {
              const row = { id: 'master-1', ...data };
              pending.users.push(row);
              return Object.fromEntries(
                Object.keys(select)
                  .filter((key) => select[key] === true)
                  .map((key) => [key, row[key]]),
              );
            }),
          },
          tenant: {
            create: jest.fn(async ({ data, select }) => {
              const row = { id: 'tenant-1', ...data };
              pending.tenants.push(row);
              return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
            }),
            findFirst: jest.fn(async ({ where }) => readTenant(pending, where.id)),
            update: jest.fn(async ({ where, data }) => {
              Object.assign(
                pending.tenants.find((t) => t.id === where.id),
                data,
              );
            }),
            updateMany: jest.fn(async ({ where, data }) => {
              const rows = pending.tenants.filter(
                (t) =>
                  t.id === where.id &&
                  (t.isPlatform ?? false) === where.isPlatform &&
                  (t.isActive ?? true) === where.isActive,
              );
              rows.forEach((row) => Object.assign(row, data));
              return { count: rows.length };
            }),
          },
          refreshToken: {
            updateMany: jest.fn(async ({ where, data }) => {
              const rows = pending.refreshTokens.filter(
                (t) =>
                  (where.userId
                    ? t.userId === where.userId
                    : pending.users.find((u) => u.id === t.userId)?.tenantId ===
                      where.user.tenantId) && t.isRevoked === where.isRevoked,
              );
              rows.forEach((row) => Object.assign(row, data));
              return { count: rows.length };
            }),
          },
          tenantSettings: {
            create: jest.fn(async ({ data }) => {
              pending.settings.push(data);
              return data;
            }),
          },
          tenantSubscription: {
            create: jest.fn(async ({ data }) => {
              const row = { id: 'subscription-1', currency: 'USD', ...data };
              pending.subscriptions.push(row);
              return row;
            }),
            // Only the plan of the subscription is read inside a transaction.
            findUniqueOrThrow: jest.fn(async ({ where }) => ({
              plan: PLANS.get(
                pending.subscriptions.find((s) => s.tenantId === where.tenantId).planId,
              ),
            })),
          },
          tenantModule: {
            createMany: jest.fn(async ({ data }) => {
              pending.modules.push(...data);
            }),
            findMany: jest.fn(async ({ where }) =>
              pending.modules
                .filter((m) => m.tenantId === where.tenantId)
                .map((m) => ({ moduleKey: m.moduleKey, enabled: m.enabled })),
            ),
            upsert: jest.fn(async ({ where, update, create }) => {
              const key = where.tenantId_moduleKey;
              const row = pending.modules.find(
                (m) => m.tenantId === key.tenantId && m.moduleKey === key.moduleKey,
              );
              if (row) Object.assign(row, update);
              else pending.modules.push(create);
            }),
          },
          subscriptionEvent: {
            create: jest.fn(async ({ data }) => {
              pending.events.push(data);
              return data;
            }),
          },
          branch: { create: jest.fn(async ({ data }) => data) },
          tenantSpecialty: {
            createMany: jest.fn(async ({ data }) => {
              pending.selections.push(...data.map((r) => r.specialtyId));
            }),
            findMany: jest.fn(async () =>
              pending.selections.map((id) => ({ specialty: { code: CODE_OF[id] } })),
            ),
          },
        };
        prisma.lastTx = tx;
        const result = await callback(tx);
        state = pending;
        return result;
      }),
      applyRlsContext: jest.fn(async () => undefined),
    };
    auth = { hashPassword: jest.fn(async () => 'hashed-password') };
    audit = { record: jest.fn(async () => undefined) };
    catalog = {
      resolveActiveCodes: jest.fn(async (codes) => {
        const rows = [psychology, aesthetics].filter((row) => codes.includes(row.code));
        if (rows.length !== codes.length)
          throw new NotFoundException({ code: 'SPECIALTY_NOT_AVAILABLE' });
        return rows;
      }),
    };
    selection = {
      applySelection: jest.fn(async (tx, { tenantId, specialties }) => {
        await tx.tenantSpecialty.createMany({
          data: specialties.map((s) => ({ tenantId, specialtyId: s.id })),
        });
        return { tenantId, specialties, modules: [], pricing: {} };
      }),
    };
    service = new PlatformTenantsService(
      prisma as PrismaService,
      auth as AuthService,
      catalog as SpecialtyCatalogService,
      selection as TenantSpecialtiesService,
      audit as PlatformAuditService,
      new PlatformPlansService(prisma as PrismaService, audit as PlatformAuditService),
    );
  });

  it('creates tenant, settings, subscription, master and one row per module and submodule in one transaction', async () => {
    const result = await service.create(input(), 'admin-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(state.tenants).toHaveLength(1);
    expect(state.tenants[0]).toMatchObject({
      name: 'Clínica Centro',
      email: 'contact@example.com',
      phone: '555-111',
      address: 'Calle 1',
      tenantType: 'CLINIC',
    });
    expect(state.settings).toEqual([
      { tenantId: 'tenant-1', timezone: 'America/Guayaquil', locale: 'es-EC' },
    ]);
    expect(state.subscriptions).toHaveLength(1);
    expect(state.users).toHaveLength(1);
    expect(state.modules).toHaveLength(SECTION_KEYS.length);
    expect(state.modules.map((m) => m.moduleKey).sort()).toEqual([...SECTION_KEYS].sort());
    expect(result.tenant).toMatchObject({ id: 'tenant-1', name: 'Clínica Centro' });
    expect(result.sections).toHaveLength(SECTION_KEYS.length);
    expect(prisma.applyRlsContext).toHaveBeenCalledWith(prisma.lastTx, { tenantId: 'tenant-1' });
    expect(selection.applySelection.mock.calls[0][0]).toBe(prisma.lastTx);
    expect(result.specialties).toEqual([
      { id: 'specialty-1', code: 'PSYCHOLOGY', name: 'Psicología' },
    ]);
  });

  it('creates the master with role MASTER, mustChangePassword true and no professional profile', async () => {
    const result = await service.create(input(), 'admin-1');
    expect(state.users[0]).toMatchObject({
      tenantId: 'tenant-1',
      email: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Pérez',
      role: 'MASTER',
      mustChangePassword: true,
      isActive: true,
    });
    expect(state.users[0].professionalProfile).toBeUndefined();
    expect(state.users[0].professionalSpecialties).toBeUndefined();
    expect(state.subscriptions[0].seatsPsychologistsUsed).toBe(0);
    expect(result.usage.seatsPsychologistsUsed).toBe(0);
    expect(result.master).toEqual({
      id: 'master-1',
      firstName: 'Ana',
      lastName: 'Pérez',
      email: 'ana@example.com',
      mustChangePassword: true,
    });
  });

  it('turns on what the plan includes when sections are omitted, all following the plan', async () => {
    const result = await service.create(input(), 'a');
    expect(state.modules.every((m) => m.enabled && m.source === 'PLAN')).toBe(true);
    expect(result.sections.every((s) => s.enabled && s.source === 'PLAN')).toBe(true);

    state.users = [];
    state.subscriptions = [];
    state.modules = [];
    await service.create(
      input({ tenantType: 'PERSONAL', planId: 'plan_personal_basic', masterEmail: 'o@x.com' }),
      'a',
    );
    const enabled = Object.fromEntries(state.modules.map((m) => [m.moduleKey, m.enabled]));
    expect(enabled['core.admin.team']).toBe(false);
    expect(enabled['core.agenda.tasks']).toBe(true);
  });

  it('shows clinical modules separately from core sections', async () => {
    await service.create(input(), 'admin-1');
    state.modules.push({
      tenantId: 'tenant-1',
      moduleKey: 'psychology.assessments',
      enabled: false,
    });

    const detail = await service.findOne('tenant-1');

    expect(detail.sections).toHaveLength(SECTION_KEYS.length);
    expect(detail.modules).toEqual([{ key: 'psychology.assessments', enabled: false }]);
    expect(detail.subscription).toMatchObject({
      plan: { id: 'plan_clinic_basic', code: 'CLINIC_BASIC', name: 'Clínica Básico' },
      includedSpecialties: 2,
      specialtyPrice: 15,
      overriddenFields: [],
      monthlyTotal: 99,
    });
  });

  it('leaves clinical notes off by default for an aesthetic-only clinic', async () => {
    await service.create(input({ specialtyCodes: ['aesthetics'] }), 'a');
    const enabled = Object.fromEntries(state.modules.map((m) => [m.moduleKey, m.enabled]));
    expect(enabled['core.clinical.notes']).toBe(false);
    expect(enabled['core.patients']).toBe(true);
    expect(enabled['core.clinical.specialties']).toBe(true);
  });

  it('keeps clinical notes when the platform sends them for an aesthetic-only clinic', async () => {
    await service.create(input({ specialtyCodes: ['aesthetics'], sections: [...NOTES] }), 'a');
    const enabled = state.modules.filter((m) => m.enabled).map((m) => m.moduleKey);
    expect(enabled.sort()).toEqual([...NOTES].sort());
    // Off by default for an aesthetic clinic: turning it on sets it apart from the plan.
    expect(state.modules.find((m) => m.moduleKey === 'core.clinical.notes')?.source).toBe(
      'OVERRIDE',
    );
    expect(state.modules.find((m) => m.moduleKey === 'core.patients')?.source).toBe('PLAN');
  });

  it('stores the explicit section list and disables the rest', async () => {
    await service.create(input({ sections: [...CALENDAR] }), 'a');
    const enabled = state.modules.filter((m) => m.enabled).map((m) => m.moduleKey);
    expect(enabled.sort()).toEqual([...CALENDAR].sort());
    expect(state.modules).toHaveLength(SECTION_KEYS.length);
  });

  it('rejects an unknown section and an unmet dependency before writing', async () => {
    await expect(service.create(input({ sections: ['core.nope'] }), 'a')).rejects.toMatchObject({
      response: { code: 'SECTION_UNKNOWN' },
    });
    await expect(
      service.create(input({ sections: ['core.agenda', 'core.agenda.calendar'] }), 'a'),
    ).rejects.toMatchObject({ response: { code: 'SECTION_DEPENDENCY' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auth.hashPassword).not.toHaveBeenCalled();
  });

  it('requires at least one specialty for every clinic, aesthetic ones included', async () => {
    await expect(service.create(input({ specialtyCodes: [] }), 'a')).rejects.toMatchObject({
      status: 400,
      response: { code: 'SPECIALTY_SELECTION_REQUIRED' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a plan that does not match the tenant type with PLAN_TYPE_MISMATCH', async () => {
    await expect(
      service.create(input({ tenantType: 'PERSONAL', planId: 'plan_clinic_pro' }), 'a'),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PLAN_TYPE_MISMATCH' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(auth.hashPassword).not.toHaveBeenCalled();
  });

  it('rejects an unknown or archived plan before writing', async () => {
    await expect(service.create(input({ planId: 'plan_nope' }), 'a')).rejects.toMatchObject({
      status: 404,
      response: { code: 'PLAN_NOT_FOUND' },
    });
    PLANS.get('plan_clinic_pro')!.archivedAt = new Date() as any;
    try {
      await expect(service.create(input({ planId: 'plan_clinic_pro' }), 'a')).rejects.toMatchObject(
        { status: 409, response: { code: 'PLAN_ARCHIVED' } },
      );
    } finally {
      PLANS.get('plan_clinic_pro')!.archivedAt = null;
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('starts the trial days the plan suggests, with the limits of the plan', async () => {
    const before = Date.now();
    await service.create(input(), 'a');
    const clinic = state.subscriptions[0];
    expect(clinic).toMatchObject({
      planId: 'plan_clinic_basic',
      status: 'TRIALING',
      seatsPsychologistsMax: 3,
      maxActivePatients: 150,
      currentPeriodEnd: null,
    });
    expect(Number(clinic.basePrice)).toBe(99);
    const days = (clinic.trialEndsAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
    expect(state.events).toHaveLength(0);

    state.users = [];
    state.subscriptions = [];
    state.modules = [];
    await service.create(
      input({
        tenantType: 'PERSONAL',
        planId: 'plan_personal_basic',
        trialDays: 30,
        masterEmail: 'other@example.com',
      }),
      'a',
    );
    const personal = state.subscriptions[0];
    expect(personal).toMatchObject({
      status: 'TRIALING',
      seatsPsychologistsMax: 1,
      maxActivePatients: 50,
    });
    expect(Math.round((personal.trialEndsAt.getTime() - before) / 86_400_000)).toBe(30);
  });

  it('starts a paid plan ACTIVE with a one month period, no payment and a SUBSCRIPTION_ACTIVATED event by the actor', async () => {
    jest.useFakeTimers({ now: new Date('2026-01-31T10:00:00Z'), doNotFake: ['nextTick'] });
    try {
      await service.create(input({ trialDays: 0 }), 'admin-7');
    } finally {
      jest.useRealTimers();
    }
    const sub = state.subscriptions[0];
    expect(sub).toMatchObject({
      planId: 'plan_clinic_basic',
      status: 'ACTIVE',
      seatsPsychologistsMax: 3,
      maxActivePatients: 150,
      trialEndsAt: null,
    });
    expect(sub.currentPeriodStart).toEqual(new Date('2026-01-31T10:00:00Z'));
    expect(sub.currentPeriodEnd).toEqual(new Date('2026-02-28T10:00:00Z'));
    expect(prisma.lastTx.subscriptionPayment).toBeUndefined();
    expect(state.events).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-1',
        eventType: 'SUBSCRIPTION_ACTIVATED',
        newPlan: 'CLINIC_BASIC',
        newStatus: 'ACTIVE',
        triggeredByUserId: 'admin-7',
      }),
    ]);
  });

  it('rejects a master e-mail that exists with different casing', async () => {
    state.users.push({ email: 'Ana@Example.com', role: 'MASTER' });
    await expect(service.create(input(), 'a')).rejects.toBeInstanceOf(ConflictException);
    expect(state.tenants).toHaveLength(0);
    expect(prisma.lastTx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.lastTx.user.findFirst.mock.invocationCallOrder[0],
    );
  });

  it('rejects a master e-mail that belongs to a platform ADMIN', async () => {
    state.users.push({ email: 'ana@example.com', role: 'ADMIN', tenantId: 'platform' });
    await expect(service.create(input(), 'a')).rejects.toMatchObject({ status: 409 });
    expect(state.tenants).toHaveLength(0);
  });

  it('never stores or returns the temporary password in clear text', async () => {
    const result = await service.create(input(), 'a');
    expect(auth.hashPassword).toHaveBeenCalledWith(TEMP_PASSWORD);
    expect(auth.hashPassword.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$transaction.mock.invocationCallOrder[0],
    );
    expect(state.users[0].password).toBe('hashed-password');
    expect(prisma.lastTx.user.create.mock.calls[0][0].select.password).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain(TEMP_PASSWORD);
    expect(JSON.stringify(result)).not.toMatch(/hashed-password|Temp-Pass/);
  });

  it('answers 404 for the platform tenant and for an unknown id', async () => {
    state.tenants.push({ id: 'platform-1', isPlatform: true });
    await expect(service.findOne('platform-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tenant.findFirst.mock.calls[0][0].where).toEqual({
      id: 'platform-1',
      isPlatform: false,
    });
  });

  it('serves the module catalog with modules, submodules and health-only marks', () => {
    const catalogResult = service.getSectionCatalog();
    expect(catalogResult.sections.map((s) => s.key)).toEqual([...SECTION_KEYS]);
    expect(catalogResult.nonHealthSpecialtyCodes).toEqual(['AESTHETICS']);
    expect(catalogResult.sections.find((s) => s.key === 'core.clinical.notes')?.healthOnly).toBe(
      true,
    );
    expect(catalogResult.sections.find((s) => s.key === 'core.billing.cash')?.parent).toBe(
      'core.billing',
    );
    expect(catalogResult).not.toHaveProperty('defaults');
  });

  it('retries P2034 with a fresh transaction and hashes the password once', async () => {
    const original = prisma.$transaction.getMockImplementation();
    prisma.$transaction
      .mockImplementationOnce(async () => {
        throw { code: 'P2034' };
      })
      .mockImplementation(original);
    await service.create(input(), 'a');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(state.tenants).toHaveLength(1);
    expect(auth.hashPassword).toHaveBeenCalledTimes(1);
  });

  it('gives up after the third P2034 attempt', async () => {
    prisma.$transaction.mockReset().mockRejectedValue({ code: 'P2034' });
    await expect(service.create(input(), 'a')).rejects.toMatchObject({ code: 'P2034' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry an ordinary error', async () => {
    selection.applySelection.mockRejectedValueOnce(new Error('ordinary'));
    await expect(service.create(input(), 'a')).rejects.toThrow('ordinary');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('translates a P2002 on e-mail to a 409 and commits nothing', async () => {
    const transact = prisma.$transaction.getMockImplementation();
    prisma.$transaction.mockImplementation(async (callback, options) =>
      transact(async (tx) => {
        tx.user.create.mockRejectedValueOnce({
          code: 'P2002',
          meta: { target: ['tenantId', 'email'] },
        });
        return callback(tx);
      }, options),
    );
    await expect(service.create(input(), 'a')).rejects.toMatchObject({
      status: 409,
      response: { message: 'El correo electrónico ya está en uso' },
    });
    expect(state.tenants).toHaveLength(0);
  });

  it('rejects and commits nothing when applySelection throws after writes', async () => {
    selection.applySelection.mockImplementationOnce(async (tx, { tenantId }) => {
      await tx.tenantSpecialty.createMany({ data: [{ tenantId, specialtyId: 'specialty-1' }] });
      throw new Error('provision failed');
    });
    await expect(service.create(input(), 'a')).rejects.toThrow('provision failed');
    expect(state.tenants).toHaveLength(0);
    expect(state.users).toHaveLength(0);
    expect(state.subscriptions).toHaveLength(0);
    expect(state.modules).toHaveLength(0);
    expect(state.selections).toHaveLength(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  function seedTenant(
    id = 'tenant-1',
    overrides: Record<string, unknown> = {},
    enabled: string[] = ['core.patients', 'core.agenda', 'core.admin'],
  ) {
    const on = new Set(enabled);
    state.tenants.push({
      id,
      name: 'Clínica Norte',
      email: 'norte@example.com',
      tenantType: 'CLINIC',
      ...overrides,
    });
    state.subscriptions.push({
      tenantId: id,
      planId: 'plan_clinic_basic',
      status: 'ACTIVE',
      currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
      seatsPsychologistsMax: 3,
      seatsPsychologistsUsed: 1,
      maxActivePatients: 150,
      basePrice: 10,
      currency: 'USD',
    });
    state.users.push({
      id: `master-of-${id}`,
      tenantId: id,
      role: 'MASTER',
      firstName: 'Ana',
      lastName: 'Pérez',
      email: `ana-${id}@example.com`,
      password: 'old-hash',
      mustChangePassword: false,
    });
    state.modules.push(
      ...SECTION_KEYS.map((moduleKey) => ({
        tenantId: id,
        moduleKey,
        enabled: on.has(moduleKey),
        source: on.has(moduleKey) ? 'PLAN' : 'OVERRIDE',
      })),
    );
  }

  const activeKeys = (id = 'tenant-1') =>
    state.modules
      .filter((m) => m.tenantId === id && m.enabled)
      .map((m) => m.moduleKey)
      .sort();

  describe('platform management', () => {
    it('lists clinics newest first and never the platform tenant', async () => {
      listRows = [
        {
          id: 'tenant-2',
          name: 'Clínica Sur',
          tenantType: 'CLINIC',
          isActive: true,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          users: [{ firstName: 'Ana', lastName: 'Pérez', email: 'ana@example.com' }],
          subscription: {
            plan: { id: 'plan_clinic_basic', code: 'CLINIC_BASIC', name: 'Clínica Básico' },
            status: 'ACTIVE',
            seatsPsychologistsUsed: 2,
            seatsPsychologistsMax: 3,
            activePatientsCount: 12,
            maxActivePatients: 150,
          },
        },
        {
          id: 'tenant-3',
          name: 'Sin plan',
          tenantType: 'PERSONAL',
          isActive: false,
          createdAt: new Date('2026-09-01T00:00:00Z'),
          users: [],
          subscription: null,
        },
      ];
      const result = await service.list({ page: 2, pageSize: 5 });
      const args = prisma.tenant.findMany.mock.calls[0][0];
      expect(args.where.isPlatform).toBe(false);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args).toMatchObject({ skip: 5, take: 5 });
      expect(prisma.tenant.count.mock.calls[0][0].where).toEqual(args.where);
      expect(result).toMatchObject({ total: 2, page: 2, pageSize: 5 });
      expect(result.items[0]).toEqual({
        id: 'tenant-2',
        name: 'Clínica Sur',
        tenantType: 'CLINIC',
        isActive: true,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        master: { firstName: 'Ana', lastName: 'Pérez', email: 'ana@example.com' },
        plan: { id: 'plan_clinic_basic', code: 'CLINIC_BASIC', name: 'Clínica Básico' },
        status: 'ACTIVE',
        seatsPsychologistsUsed: 2,
        seatsPsychologistsMax: 3,
        activePatientsCount: 12,
        maxActivePatients: 150,
      });
      expect(result.items[1]).toMatchObject({
        master: null,
        plan: null,
        status: null,
        seatsPsychologistsUsed: 0,
        maxActivePatients: 0,
      });
    });

    it('searches by clinic name, clinic e-mail and master name without case', async () => {
      await service.list({ search: '  AnA% ', page: 1, pageSize: 20 });
      const where = prisma.tenant.findMany.mock.calls[0][0].where;
      const term = { contains: 'AnA%', mode: 'insensitive' };
      expect(where.isPlatform).toBe(false);
      expect(where.OR).toEqual([
        { name: term },
        { email: term },
        { users: { some: { role: 'MASTER', firstName: term } } },
        { users: { some: { role: 'MASTER', lastName: term } } },
        { users: { some: { role: 'MASTER', email: term } } },
      ]);
    });

    it('filters by plan, subscription status and active flag', async () => {
      await service.list({
        planId: 'plan_clinic_pro',
        status: 'PAST_DUE',
        isActive: false,
        page: 1,
        pageSize: 20,
      });
      expect(prisma.tenant.findMany.mock.calls[0][0].where).toEqual({
        isPlatform: false,
        isActive: false,
        subscription: { is: { planId: 'plan_clinic_pro', status: 'PAST_DUE' } },
      });
      await service.list({ page: 1, pageSize: 20 });
      expect(prisma.tenant.findMany.mock.calls[1][0].where).toEqual({ isPlatform: false });
    });

    it('caps pageSize at 100', async () => {
      const result = await service.list({ page: 1, pageSize: 500 });
      expect(prisma.tenant.findMany.mock.calls[0][0].take).toBe(100);
      expect(result.pageSize).toBe(100);
    });

    it('returns only counters, never patients or appointments', async () => {
      await service.list({ page: 1, pageSize: 20 });
      const select = prisma.tenant.findMany.mock.calls[0][0].select;
      expect(Object.keys(select).sort()).toEqual(
        ['createdAt', 'id', 'isActive', 'name', 'subscription', 'tenantType', 'users'].sort(),
      );
      expect(Object.keys(select.subscription.select).sort()).toEqual(
        [
          'activePatientsCount',
          'maxActivePatients',
          'plan',
          'seatsPsychologistsMax',
          'seatsPsychologistsUsed',
          'status',
        ].sort(),
      );
      expect(Object.keys(select.users.select).sort()).toEqual(['email', 'firstName', 'lastName']);
    });

    it('updates the account data and audits before and after', async () => {
      seedTenant('tenant-1', { phone: '111', address: 'Calle 1' });
      const result = await service.updateAccount(
        'tenant-1',
        { name: 'Clínica Nueva', email: 'NUEVA@Example.com', phone: '222' },
        'admin-1',
      );
      expect(state.tenants[0]).toMatchObject({
        name: 'Clínica Nueva',
        email: 'nueva@example.com',
        phone: '222',
        address: 'Calle 1',
      });
      expect(result.tenant).toMatchObject({ name: 'Clínica Nueva', email: 'nueva@example.com' });
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-1',
          actorId: 'admin-1',
          entity: 'TENANT',
          entityId: 'tenant-1',
          changes: {
            before: { name: 'Clínica Norte', email: 'norte@example.com', phone: '111' },
            after: { name: 'Clínica Nueva', email: 'nueva@example.com', phone: '222' },
          },
        },
        prisma.lastTx,
      );
    });

    it('suspends: sets isActive false, revokes every refresh token of the clinic and audits the reason', async () => {
      seedTenant('tenant-1');
      seedTenant('tenant-2');
      state.refreshTokens.push(
        { userId: 'master-of-tenant-1', isRevoked: false },
        { userId: 'master-of-tenant-1', isRevoked: false },
        { userId: 'master-of-tenant-2', isRevoked: false },
      );
      const result = await service.suspend('tenant-1', 'Falta de pago', 'admin-1');
      expect(result.tenant.isActive).toBe(false);
      expect(state.refreshTokens.map((t) => t.isRevoked)).toEqual([true, true, false]);
      expect(state.tenants[1].isActive).toBeUndefined();
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-1',
          actorId: 'admin-1',
          entity: 'TENANT',
          entityId: 'tenant-1',
          reason: 'Falta de pago',
          changes: { before: { isActive: true }, after: { isActive: false } },
        },
        prisma.lastTx,
      );
    });

    it('returns the current state without a second audit row when suspending a suspended clinic', async () => {
      seedTenant('tenant-1', { isActive: false });
      state.refreshTokens.push({ userId: 'master-of-tenant-1', isRevoked: false });
      const result = await service.suspend('tenant-1', 'Otra vez', 'admin-1');
      expect(result.tenant.isActive).toBe(false);
      expect(audit.record).not.toHaveBeenCalled();
      expect(prisma.lastTx.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('reactivates, and does nothing when the clinic is already active', async () => {
      seedTenant('tenant-1', { isActive: false });
      const result = await service.reactivate('tenant-1', 'admin-1');
      expect(result.tenant.isActive).toBe(true);
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-1',
          actorId: 'admin-1',
          entity: 'TENANT',
          entityId: 'tenant-1',
          changes: { before: { isActive: false }, after: { isActive: true } },
        },
        prisma.lastTx,
      );
      audit.record.mockClear();
      const again = await service.reactivate('tenant-1', 'admin-1');
      expect(again.tenant.isActive).toBe(true);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('replaces the section list: listed keys enabled, the others disabled, rows never deleted', async () => {
      seedTenant('tenant-1');
      const result = await service.setSections(
        'tenant-1',
        ['core.patients', 'core.billing', 'core.patients'],
        'admin-1',
      );
      expect(state.modules).toHaveLength(SECTION_KEYS.length);
      expect(activeKeys()).toEqual(['core.billing', 'core.patients']);
      expect(prisma.lastTx.tenantModule.upsert).toHaveBeenCalledTimes(SECTION_KEYS.length);
      // The plan turns every module on: what was turned off is set apart from it.
      const sourceOf = (key: string) => state.modules.find((m) => m.moduleKey === key)?.source;
      expect(sourceOf('core.billing')).toBe('PLAN');
      expect(sourceOf('core.agenda')).toBe('OVERRIDE');
      expect(
        result.sections
          .filter((s) => s.enabled)
          .map((s) => s.key)
          .sort(),
      ).toEqual(['core.billing', 'core.patients']);
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-1',
          actorId: 'admin-1',
          entity: 'TENANT',
          entityId: 'tenant-1',
          changes: {
            before: { sections: ['core.agenda', 'core.patients', 'core.admin'] },
            after: { sections: ['core.patients', 'core.billing'] },
          },
        },
        prisma.lastTx,
      );
    });

    it('rejects SECTION_UNKNOWN and SECTION_DEPENDENCY without changing any row', async () => {
      seedTenant('tenant-1');
      const before = structuredClone(state.modules);
      await expect(service.setSections('tenant-1', ['core.nope'], 'admin-1')).rejects.toMatchObject(
        { response: { code: 'SECTION_UNKNOWN' } },
      );
      await expect(
        service.setSections('tenant-1', ['core.agenda', 'core.agenda.calendar'], 'admin-1'),
      ).rejects.toMatchObject({ response: { code: 'SECTION_DEPENDENCY' } });
      expect(state.modules).toEqual(before);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('resets the master password: new hash, mustChangePassword true, refresh tokens revoked, audit without the password', async () => {
      seedTenant('tenant-1');
      state.users.push({ id: 'staff-1', tenantId: 'tenant-1', role: 'PSICOLOGO' });
      state.refreshTokens.push(
        { userId: 'master-of-tenant-1', isRevoked: false },
        { userId: 'staff-1', isRevoked: false },
      );
      const result = await service.resetMasterPassword('tenant-1', ' Nueva-Clave-1 ', 'admin-1');
      expect(result).toBeUndefined();
      expect(auth.hashPassword).toHaveBeenCalledWith(' Nueva-Clave-1 ');
      expect(state.users[0]).toMatchObject({
        password: 'hashed-password',
        mustChangePassword: true,
      });
      expect(state.refreshTokens.map((t) => t.isRevoked)).toEqual([true, false]);
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-1',
          actorId: 'admin-1',
          entity: 'USER',
          entityId: 'master-of-tenant-1',
          changes: { before: { mustChangePassword: false }, after: { mustChangePassword: true } },
        },
        prisma.lastTx,
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(/Nueva-Clave|hashed-password/);
    });

    it('answers 404 on every method for the platform tenant', async () => {
      state.tenants.push({ id: 'platform-1', isPlatform: true });
      const calls = [
        () => service.updateAccount('platform-1', { name: 'X' }, 'a'),
        () => service.suspend('platform-1', 'x', 'a'),
        () => service.reactivate('platform-1', 'a'),
        () => service.setSections('platform-1', ['core.patients'], 'a'),
        () => service.resetMasterPassword('platform-1', 'Password-1', 'a'),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(auth.hashPassword).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(state.tenants[0].isActive).toBeUndefined();
    });
  });
});
