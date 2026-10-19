import { ForbiddenException, Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { grantablePermissions, Permission, rolePermissions } from './permission-catalog';

export interface PermissionSubject {
  userId: string;
  tenantId: string;
  role: string;
}

/** Answers whether the platform enabled an action for a role in this clinic. */
@Injectable()
export class PermissionChecker {
  constructor(private readonly prisma: PrismaService) {}

  async isWithdrawn(user: PermissionSubject, permission: Permission): Promise<boolean> {
    const withdrawn = await this.prisma.tenantRolePermission.findFirst({
      where: { tenantId: user.tenantId, role: user.role as UserRole, permission, granted: false },
      select: { id: true },
    });
    return withdrawn !== null;
  }

  /** Whether the platform granted the action to this clinic role. */
  async isGranted(user: PermissionSubject, permission: Permission): Promise<boolean> {
    if (!grantablePermissions(user.role).includes(permission)) return false;
    const granted = await this.prisma.tenantRolePermission.findFirst({
      where: { tenantId: user.tenantId, role: user.role as UserRole, permission, granted: true },
      select: { id: true },
    });
    return granted !== null;
  }

  /** Throws PERMISSION_DENIED (403) when the user does not have the permission. */
  async assertAllowed(user: PermissionSubject, permission: Permission): Promise<void> {
    if (!rolePermissions(user.role).includes(permission)) {
      if (await this.isGranted(user, permission)) return;
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PERMISSION_DENIED',
        message: 'Tu rol no tiene este permiso. Solicita acceso al administrador de la plataforma.',
        permission,
      });
    }
    if (await this.isWithdrawn(user, permission)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PERMISSION_DENIED',
        message: 'El administrador de la plataforma retiró este permiso de tu rol.',
        permission,
      });
    }
  }
}
