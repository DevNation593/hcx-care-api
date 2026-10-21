import { PermissionChecker } from './permission-checker.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UserPermissionsService } from '../../users/user-permissions.service';

describe('clinic role permission enforcement', () => {
  const db = {
    tenantRolePermission: { findFirst: jest.fn(), findMany: jest.fn() },
    userPermission: { findFirst: jest.fn(), findMany: jest.fn() },
    user: { findFirst: jest.fn() },
  };
  const checker = new PermissionChecker(db as unknown as PrismaService);
  const descriptions = new UserPermissionsService(db as unknown as PrismaService);

  beforeEach(() => {
    jest.resetAllMocks();
    db.tenantRolePermission.findFirst.mockResolvedValue(null);
    db.tenantRolePermission.findMany.mockResolvedValue([]);
    db.user.findFirst.mockResolvedValue({
      id: 'master-1',
      role: 'MASTER',
      tenant: { businessKind: 'MEDICAL' },
    });
  });

  it('denies a MASTER when the platform removes an action from that clinic role', async () => {
    db.tenantRolePermission.findFirst.mockResolvedValue({ id: 'removed' });

    await expect(
      checker.assertAllowed(
        { userId: 'master-1', tenantId: 'clinic-1', role: 'MASTER' },
        'billing.create',
      ),
    ).rejects.toMatchObject({ status: 403, response: { code: 'PERMISSION_DENIED' } });
    expect(db.tenantRolePermission.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'clinic-1', role: 'MASTER', permission: 'billing.create', granted: false },
      select: { id: true },
    });
    expect(db.userPermission.findFirst).not.toHaveBeenCalled();
  });

  it('gives every assistant in the same clinic a permission granted to their role', async () => {
    db.tenantRolePermission.findFirst.mockResolvedValue({ id: 'grant' });
    for (const userId of ['assistant-1', 'assistant-2']) {
      await expect(
        checker.assertAllowed({ userId, tenantId: 'clinic-1', role: 'ASISTENTE' }, 'billing.view'),
      ).resolves.toBeUndefined();
    }
    expect(db.tenantRolePermission.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 'clinic-1', role: 'ASISTENTE', permission: 'billing.view', granted: true },
      select: { id: true },
    });
    expect(db.userPermission.findFirst).not.toHaveBeenCalled();
  });

  it('shows the master the permissions set for MASTER in its own clinic', async () => {
    db.tenantRolePermission.findMany.mockResolvedValue([
      { permission: 'billing.create', granted: false },
    ]);
    db.userPermission.findMany.mockResolvedValue([{ permission: 'billing.create', granted: true }]);

    const result = await descriptions.describe('clinic-1', 'master-1');

    expect(result.effective).not.toContain('billing.create');
    expect(db.tenantRolePermission.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'clinic-1', role: 'MASTER' },
      select: { permission: true, granted: true },
    });
    expect(db.userPermission.findMany).not.toHaveBeenCalled();
  });

  it('describes only aesthetic actions to a studio member', async () => {
    db.user.findFirst.mockResolvedValue({
      id: 'master-1',
      role: 'MASTER',
      tenant: { businessKind: 'AESTHETIC_STUDIO' },
    });
    const result = await descriptions.describe('studio-1', 'master-1');
    expect(result.effective).toContain('aesthetics.view');
    expect(result.effective).not.toContain('patients.create');
    expect(result.permissions.every((permission) => permission.key.startsWith('aesthetics.'))).toBe(
      true,
    );
  });
});
