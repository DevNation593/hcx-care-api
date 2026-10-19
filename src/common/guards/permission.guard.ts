import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { Permission, REQUIRE_PERMISSION_KEY } from '../permissions/permission-catalog';
import { PermissionChecker } from '../permissions/permission-checker.service';

/**
 * Refuses a route when the platform withdrew its permission from this clinic role, and to a
 * role the route does not list unless the platform granted it: the role guard lets that
 * role through only so that this guard can decide.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly checker: PermissionChecker,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(
      REQUIRE_PERMISSION_KEY,
      targets,
    );
    if (!permission || this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const user = context.switchToHttp().getRequest().user;
    if (!user?.userId) return true;

    await this.checker.assertAllowed(user, permission);
    return true;
  }
}
