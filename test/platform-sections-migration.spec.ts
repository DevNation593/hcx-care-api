import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createPlatformAdmin } from '../prisma/create-platform-admin';
import { auditPlatformSections, hasBlockingIssues } from '../prisma/audit-platform-sections';
import { SECTION_KEYS } from '../src/common/sections/section-catalog';

type TenantRow = { id: string; isPlatform?: boolean };
type UserRow = { id: string; tenantId: string; role: string; isActive?: boolean };

function sectionRows(tenantId: string, count: number = SECTION_KEYS.length) {
  return SECTION_KEYS.slice(0, count).map((moduleKey) => ({ tenantId, moduleKey }));
}

function fakeClient(
  tenants: TenantRow[],
  users: UserRow[],
  modules: { tenantId: string; moduleKey: string }[],
) {
  return {
    tenant: {
      findMany: async () => tenants.map((t) => ({ id: t.id, isPlatform: t.isPlatform ?? false })),
    },
    tenantModule: { findMany: async () => modules },
    user: {
      findMany: async ({ where }: { where: { role: string; isActive?: boolean } }) =>
        users.filter(
          (u) =>
            u.role === where.role &&
            (where.isActive === undefined || (u.isActive ?? true) === where.isActive),
        ),
    },
  };
}

const platformAdmin: UserRow = { id: 'pa', tenantId: 'platform', role: 'ADMIN' };

describe('platform sections migration audit', () => {
  it('reports a clean database as non-blocking', async () => {
    const audit = await auditPlatformSections(
      fakeClient(
        [{ id: 't1' }, { id: 'platform', isPlatform: true }],
        [{ id: 'm1', tenantId: 't1', role: 'MASTER' }, platformAdmin],
        sectionRows('t1'),
      ) as never,
    );
    expect(audit).toEqual({
      tenantsWithMissingSections: [],
      platformTenants: ['platform'],
      adminsOutsidePlatform: [],
      activeSupportUsers: [],
    });
    expect(hasBlockingIssues(audit)).toBe(false);
  });

  it('flags a clinic with fewer than eight section rows', async () => {
    const audit = await auditPlatformSections(
      fakeClient(
        [{ id: 't1' }, { id: 't2' }],
        [],
        [...sectionRows('t1', 7), ...sectionRows('t2')],
      ) as never,
    );
    expect(audit.tenantsWithMissingSections).toEqual(['t1']);
    expect(hasBlockingIssues(audit)).toBe(true);
  });

  it('ignores the platform tenant when counting sections', async () => {
    const audit = await auditPlatformSections(
      fakeClient([{ id: 'platform', isPlatform: true }], [platformAdmin], []) as never,
    );
    expect(audit.tenantsWithMissingSections).toEqual([]);
    expect(hasBlockingIssues(audit)).toBe(false);
  });

  it('flags a second platform tenant', async () => {
    const audit = await auditPlatformSections(
      fakeClient(
        [
          { id: 'p1', isPlatform: true },
          { id: 'p2', isPlatform: true },
        ],
        [],
        [],
      ) as never,
    );
    expect(audit.platformTenants).toHaveLength(2);
    expect(hasBlockingIssues(audit)).toBe(true);
  });

  it('flags an ADMIN outside the platform tenant', async () => {
    const audit = await auditPlatformSections(
      fakeClient(
        [{ id: 't1' }, { id: 'platform', isPlatform: true }],
        [platformAdmin, { id: 'stray', tenantId: 't1', role: 'ADMIN' }],
        sectionRows('t1'),
      ) as never,
    );
    expect(audit.adminsOutsidePlatform).toEqual(['stray']);
    expect(hasBlockingIssues(audit)).toBe(true);
  });

  it('flags an active SOPORTE user and ignores inactive ones', async () => {
    const audit = await auditPlatformSections(
      fakeClient(
        [{ id: 't1' }],
        [
          { id: 's1', tenantId: 't1', role: 'SOPORTE', isActive: true },
          { id: 's2', tenantId: 't1', role: 'SOPORTE', isActive: false },
        ],
        sectionRows('t1'),
      ) as never,
    );
    expect(audit.activeSupportUsers).toEqual(['s1']);
    expect(hasBlockingIssues(audit)).toBe(true);
  });

  it('exposes isPlatform and mustChangePassword in the generated client', () => {
    const model = (name: string) => Prisma.dmmf.datamodel.models.find((m) => m.name === name)!;
    expect(model('Tenant').fields.map((f) => f.name)).toContain('isPlatform');
    expect(model('User').fields.map((f) => f.name)).toContain('mustChangePassword');
  });
});

describe('createPlatformAdmin', () => {
  const input = {
    email: 'Admin@Plataforma.test',
    password: 'Secret123!',
    firstName: 'Ada',
    lastName: 'Root',
  };

  function creator(existingUser: boolean, existingPlatform: boolean) {
    const tenantCreate = jest.fn(async () => ({ id: 'new-tenant' }));
    const userCreate = jest.fn(async () => ({ id: 'new-user' }));
    const userFindFirst = jest.fn(async () => (existingUser ? { id: 'dup' } : null));
    const client = {
      user: { findFirst: userFindFirst, create: userCreate },
      tenant: {
        findFirst: jest.fn(async () => (existingPlatform ? { id: 'platform' } : null)),
        create: tenantCreate,
      },
    };
    return { client, tenantCreate, userCreate, userFindFirst };
  }

  it('creates the platform tenant and an ADMIN with a hashed password', async () => {
    const { client, tenantCreate, userCreate } = creator(false, false);
    await expect(createPlatformAdmin(client as never, input)).resolves.toEqual({
      tenantId: 'new-tenant',
      userId: 'new-user',
    });
    expect(tenantCreate).toHaveBeenCalledWith({
      data: { name: 'Plataforma', email: input.email, isPlatform: true, onboardingCompleted: true },
    });
    const data = (userCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
      .data;
    expect(data).toMatchObject({
      tenantId: 'new-tenant',
      role: 'ADMIN',
      isActive: true,
      emailVerified: true,
      mustChangePassword: false,
    });
    expect(data.password).not.toBe(input.password);
    await expect(bcrypt.compare(input.password, data.password as string)).resolves.toBe(true);
  });

  it('reuses an existing platform tenant', async () => {
    const { client, tenantCreate } = creator(false, true);
    await expect(createPlatformAdmin(client as never, input)).resolves.toMatchObject({
      tenantId: 'platform',
    });
    expect(tenantCreate).not.toHaveBeenCalled();
  });

  it('fails when the email already exists, ignoring case', async () => {
    const { client, userCreate, userFindFirst } = creator(true, true);
    await expect(createPlatformAdmin(client as never, input)).rejects.toThrow(
      /Ya existe un usuario/,
    );
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: input.email, mode: 'insensitive' } },
      }),
    );
    expect(userCreate).not.toHaveBeenCalled();
  });
});
