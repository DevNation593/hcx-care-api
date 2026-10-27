import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { areRolesEquivalent, isCashierRole } from '../roles/role-compatibility';
import {
  grantablePermissions,
  Permission,
  REQUIRE_PERMISSION_KEY,
  rolePermissions,
} from '../permissions/permission-catalog';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.role) {
      throw new ForbiddenException('Rol de usuario no encontrado');
    }

    const hasRole = requiredRoles.some((role) => areRolesEquivalent(user.role, role));

    if (!hasRole) {
      // A role outside the list may still hold the route's permission through a platform grant,
      // or, for the cashier only, by default: its own permissions open the MASTER-only billing
      // routes. Other roles keep the list as final for permissions they hold by default (a MASTER
      // must not reach PROFESIONAL-only clinical writes). The permission guard, which reads the
      // grants and the withdrawals, has the last word.
      const permission = this.reflector.getAllAndOverride<Permission | undefined>(
        REQUIRE_PERMISSION_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (
        permission &&
        ((isCashierRole(user.role) && rolePermissions(user.role).includes(permission)) ||
          grantablePermissions(user.role).includes(permission))
      ) {
        return true;
      }

      throw new ForbiddenException(`Required roles: ${requiredRoles.join(', ')}`);
    }

    return true;
  }
}
