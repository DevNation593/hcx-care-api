import { PrismaService } from '../prisma/prisma.service';
import { PlatformAuditService } from './platform-audit.service';
import { PlatformRolePermissionsService } from './platform-role-permissions.service';

describe('PlatformRolePermissionsService', () => {
  const db = {
    tenant: { findFirst: jest.fn() },
    tenantRolePermission: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const audit = { record: jest.fn() };
  const service = new PlatformRolePermissionsService(
    prisma as unknown as PrismaService,
    audit as unknown as PlatformAuditService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    db.tenant.findFirst.mockResolvedValue({ id: 'clinic-1' });
    db.tenantRolePermission.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
  });

  it('shows a clinic role with its stored grants and withdrawals', async () => {
    db.tenantRolePermission.findMany.mockResolvedValue([
      { permission: 'appointments.cancel', granted: false },
      { permission: 'billing.view', granted: true },
    ]);

    const result = await service.describe('clinic-1', 'ASISTENTE');

    expect(result.effective).toContain('billing.view');
    expect(result.effective).not.toContain('appointments.cancel');
    expect(result.permissions.find((entry) => entry.key === 'billing.view')).toMatchObject({
      allowed: true,
      source: 'grant',
    });
  });

  it('offers aesthetic permissions only to studio roles', async () => {
    db.tenant.findFirst.mockResolvedValue({ id: 'studio-1', businessKind: 'AESTHETIC_STUDIO' });
    const result = await service.describe('studio-1', 'MASTER');
    expect(result.permissions.length).toBeGreaterThan(0);
    expect(result.permissions.every((entry) => entry.key.startsWith('aesthetics.'))).toBe(true);
    await expect(
      service.replace('studio-1', 'MASTER', 'platform-admin', ['clinical_records.view']),
    ).rejects.toMatchObject({ response: { code: 'PERMISSION_INVALID' } });
  });

  it('can withdraw a permission from MASTER for the whole clinic', async () => {
    await service.replace('clinic-1', 'MASTER', 'platform-admin', ['patients.create']);

    expect(db.tenantRolePermission.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          tenantId: 'clinic-1',
          role: 'MASTER',
          permission: 'billing.create',
          granted: false,
          createdById: 'platform-admin',
        }),
      ]),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'clinic-1',
        actorId: 'platform-admin',
        entity: 'TENANT',
        entityId: 'clinic-1',
        changes: expect.objectContaining({
          before: expect.objectContaining({ role: 'MASTER' }),
          after: expect.objectContaining({ role: 'MASTER', allowed: ['patients.create'] }),
        }),
      }),
      db,
    );
  });

  it('rejects permissions the role cannot receive', async () => {
    await expect(
      service.replace('clinic-1', 'ASISTENTE', 'platform-admin', ['clinical_records.view']),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PERMISSION_INVALID' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an empty permission key before writing changes', async () => {
    await expect(
      service.replace('clinic-1', 'ASISTENTE', 'platform-admin', ['']),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PERMISSION_INVALID' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects the platform tenant as a clinic', async () => {
    db.tenant.findFirst.mockResolvedValue(null);
    await expect(service.describe('platform-1', 'MASTER')).rejects.toMatchObject({ status: 404 });
  });
});
