import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantBusinessKind } from '@prisma/client';
import {
  effectivePermissions,
  grantablePermissions,
  isPermissionForBusinessKind,
  PERMISSION_CATALOG,
  rolePermissions,
} from '../common/permissions/permission-catalog';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UserPermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Effective clinic role permissions for the signed-in user. */
  async describe(tenantId: string, userId: string) {
    const user = await this.findUser(tenantId, userId);
    const { revoked, granted } = await this.overridesOf(tenantId, user.role);
    const businessKind = user.tenant.businessKind ?? TenantBusinessKind.MEDICAL;
    const belongs = (permission: (typeof PERMISSION_CATALOG)[number]['key']) =>
      isPermissionForBusinessKind(permission, businessKind);
    const byRole = rolePermissions(user.role).filter(belongs);
    const grantable = grantablePermissions(user.role).filter(belongs);
    const effective = effectivePermissions(user.role, revoked, granted).filter(belongs);

    return {
      userId,
      role: user.role,
      effective,
      permissions: PERMISSION_CATALOG.filter(
        (entry) =>
          belongs(entry.key) && (byRole.includes(entry.key) || grantable.includes(entry.key)),
      ).map(({ key, group, label }) => ({
        key,
        group,
        label,
        allowed: effective.includes(key),
        // 'role': enabled by default for this role. 'grant': available through platform configuration.
        source: byRole.includes(key) ? ('role' as const) : ('grant' as const),
      })),
    };
  }

  private async findUser(tenantId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, role: true, tenant: { select: { businessKind: true } } },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return user;
  }

  private async overridesOf(tenantId: string, role: import('@prisma/client').UserRole) {
    const rows = await this.prisma.tenantRolePermission.findMany({
      where: { tenantId, role },
      select: { permission: true, granted: true },
    });
    const of = (granted: boolean) =>
      rows.filter((row) => row.granted === granted).map(({ permission }) => permission);
    return { revoked: of(false), granted: of(true) };
  }
}
