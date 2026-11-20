import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PLATFORM_ROUTE_KEY } from '../decorators/platform-route.decorator';
import { SESSION_ROUTE_KEY } from '../decorators/session-route.decorator';
import { RlsContextService } from '../../prisma/rls-context.service';

/**
 * TenantGuard ensures that users can only access resources within their own tenant.
 * It validates that the tenantId in the URL/body matches the user's tenantId from JWT.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly rlsContext: RlsContextService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const isPlatformRoute = this.reflector.getAllAndOverride<boolean>(PLATFORM_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Fail closed: a public check that runs first would leave a platform route open to anyone.
    if (isPublic && isPlatformRoute) {
      throw new Error('A platform route cannot be public');
    }

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.tenantId) {
      throw new ForbiddenException(
        'No se pudo identificar tu consultorio. Vuelve a iniciar sesión.',
      );
    }

    if (isPlatformRoute) {
      // Platform routes are the only ones an ADMIN may call, and only from the platform tenant.
      // They manage other tenants, so the tenant id in params/body is deliberately not compared.
      if (user.role !== 'ADMIN' || user.isPlatformTenant !== true) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'PLATFORM_ONLY',
          message: 'Esta ruta es exclusiva del panel de control.',
        });
      }
      request.tenantId = user.tenantId;
      this.rlsContext.set({
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      });
      return true;
    }

    const isSessionRoute = this.reflector.getAllAndOverride<boolean>(SESSION_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // The platform ADMIN is confined to platform routes and its own session routes.
    if (user.role === 'ADMIN' && !isSessionRoute) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PLATFORM_ONLY',
        message: 'Esta cuenta solo tiene acceso al panel de control.',
      });
    }

    // Check tenantId in params (e.g., /tenants/:tenantId/users)
    const tenantIdFromParams = request.params?.tenantId;

    // Check tenantId in body (for POST/PUT requests)
    const tenantIdFromBody = request.body?.tenantId;

    // If tenantId is provided in params, validate it
    if (tenantIdFromParams) {
      if (tenantIdFromParams !== user.tenantId) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'TENANT_SCOPE_VIOLATION',
          message: 'No tienes acceso a la información de este consultorio.',
        });
      }
    }

    // If tenantId is provided in body, validate and ensure it matches
    if (tenantIdFromBody) {
      if (tenantIdFromBody !== user.tenantId) {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'TENANT_SCOPE_VIOLATION',
          message: 'No puedes registrar información en otro consultorio.',
        });
      }
    }

    // Inject user's tenantId into the request for convenience
    request.tenantId = user.tenantId;
    this.rlsContext.set({
      tenantId: user.tenantId,
      userId: user.userId,
      role: user.role,
    });

    return true;
  }
}
