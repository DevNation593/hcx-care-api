import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantGuard } from './tenant.guard';
import { RlsContextService } from '../../prisma/rls-context.service';
import { Public } from '../decorators/public.decorator';
import { PlatformRoute } from '../decorators/platform-route.decorator';
import { SessionRoute } from '../decorators/session-route.decorator';

@PlatformRoute()
class PlatformController {
  handler() {}
}

@SessionRoute()
class SessionController {
  handler() {}
}

class ClinicController {
  handler() {}
}

@Public()
@PlatformRoute()
class PublicPlatformController {
  handler() {}
}

describe('TenantGuard scope errors', () => {
  const rls = new RlsContextService();
  const guard = new TenantGuard(new Reflector(), rls);
  const user = {
    tenantId: 'tenant-1',
    userId: 'actor',
    role: 'MASTER',
    isPlatformTenant: false,
    mustChangePassword: false,
  };
  const context = (request: unknown) =>
    ({
      getHandler: () => () => undefined,
      getClass: () => TenantGuard,
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  it.each([
    [
      { params: { tenantId: 'tenant-2' } },
      'No tienes acceso a la información de este consultorio.',
    ],
    [
      { body: { tenantId: 'tenant-2' } },
      'Acceso denegado: No puede crear recursos para otro tenant',
    ],
  ])('returns stable scope errors without setting RLS for %j', (input, message) => {
    rls.run({}, () => {
      let caught: unknown;
      try {
        guard.canActivate(context({ ...input, user }));
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        status: 403,
        response: { statusCode: 403, code: 'TENANT_SCOPE_VIOLATION', message },
      });
      expect(rls.get()).toEqual({});
    });
  });

  it('initializes the matching request tenant and RLS context', () => {
    const request = {
      user,
      params: { tenantId: 'tenant-1' },
      body: { tenantId: 'tenant-1' },
      tenantId: undefined,
    };
    rls.run({}, () => {
      expect(guard.canActivate(context(request))).toBe(true);
      expect(request.tenantId).toBe('tenant-1');
      expect(rls.get()).toEqual({ tenantId: 'tenant-1', userId: 'actor', role: 'MASTER' });
    });
  });

  describe('platform access rules', () => {
    const contextFor = (controller: { prototype: { handler: () => void } }, request: unknown) =>
      ({
        getHandler: () => controller.prototype.handler,
        getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => request }),
      }) as unknown as ExecutionContext;
    const admin = { ...user, tenantId: 'platform-1', role: 'ADMIN', isPlatformTenant: true };
    const catchError = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error;
      }
      return undefined;
    };

    it('lets a platform ADMIN into a platform route with another tenant id in the params', () => {
      const request: any = {
        user: admin,
        params: { tenantId: 'tenant-2' },
        body: { tenantId: 'tenant-3' },
      };
      rls.run({}, () => {
        expect(guard.canActivate(contextFor(PlatformController, request))).toBe(true);
        expect(request.tenantId).toBe('platform-1');
        expect(rls.get()).toEqual({ tenantId: 'platform-1', userId: 'actor', role: 'ADMIN' });
      });
    });

    it.each(['MASTER', 'PROFESIONAL', 'ASISTENTE', 'SOPORTE'])(
      'rejects %s on a platform route',
      (role) => {
        rls.run({}, () => {
          const error = catchError(() =>
            guard.canActivate(contextFor(PlatformController, { user: { ...user, role } })),
          );
          expect(error).toBeInstanceOf(ForbiddenException);
          expect(rls.get()).toEqual({});
        });
      },
    );

    it('rejects an ADMIN whose tenant is not the platform tenant on a platform route', () => {
      rls.run({}, () => {
        const error = catchError(() =>
          guard.canActivate(
            contextFor(PlatformController, {
              user: { ...admin, tenantId: 'tenant-1', isPlatformTenant: false },
            }),
          ),
        );
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(rls.get()).toEqual({});
      });
    });

    it('rejects an ADMIN outside the platform with PLATFORM_ONLY', () => {
      rls.run({}, () => {
        const error = catchError(() =>
          guard.canActivate(
            contextFor(ClinicController, { user: admin, params: { tenantId: 'platform-1' } }),
          ),
        );
        expect(error).toMatchObject({
          status: 403,
          response: {
            code: 'PLATFORM_ONLY',
            message: 'Esta cuenta solo tiene acceso al panel de control.',
          },
        });
        expect(rls.get()).toEqual({});
      });
    });

    it('refuses a route marked both public and platform instead of opening it', () => {
      rls.run({}, () => {
        const error = catchError(() =>
          guard.canActivate(contextFor(PublicPlatformController, { user: undefined })),
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ForbiddenException);
        expect((error as Error).message).toBe('A platform route cannot be public');
        expect(rls.get()).toEqual({});
      });
    });

    it('lets an ADMIN through a session route', () => {
      const request: any = { user: admin };
      rls.run({}, () => {
        expect(guard.canActivate(contextFor(SessionController, request))).toBe(true);
        expect(request.tenantId).toBe('platform-1');
      });
    });

    it('no longer lets SOPORTE reach another tenant', () => {
      rls.run({}, () => {
        const error = catchError(() =>
          guard.canActivate(
            contextFor(ClinicController, {
              user: { ...user, role: 'SOPORTE' },
              params: { tenantId: 'tenant-2' },
            }),
          ),
        );
        expect(error).toMatchObject({
          status: 403,
          response: { code: 'TENANT_SCOPE_VIOLATION' },
        });
        expect(rls.get()).toEqual({});
      });
    });
  });
});
