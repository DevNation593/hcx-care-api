import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '../permissions/permission-catalog';
import { RolesGuard } from './roles.guard';

function setup(role: string | undefined, requiredRoles?: string[], isPublic = false) {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
    if (key === IS_PUBLIC_KEY) return isPublic;
    if (key === ROLES_KEY) return requiredRoles;
    return undefined;
  });

  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  } as unknown as ExecutionContext;

  return { guard: new RolesGuard(reflector), context };
}

describe('RolesGuard', () => {
  it.each([
    ['MASTER', ['MASTER']],
    ['PROFESIONAL', ['MASTER', 'PROFESIONAL']],
    ['ASISTENTE', ['MASTER', 'ASISTENTE', 'PROFESIONAL']],
  ])('allows %s when metadata requires %j', (actual, required) => {
    const { guard, context } = setup(actual, required);
    expect(guard.canActivate(context)).toBe(true);
  });

  it.each(['PROFESIONAL', 'ASISTENTE', 'ADMIN', 'CLIENTE', 'PSICOLOGO', 'SOPORTE', 'PACIENTE'])(
    'rejects %s when metadata requires MASTER',
    (actual) => {
      const { guard, context } = setup(actual, ['MASTER']);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    },
  );

  it.each(['ADMIN', 'CLIENTE', 'PSICOLOGO'])(
    'rejects %s on clinical endpoints open to the whole clinic team',
    (actual) => {
      const { guard, context } = setup(actual, ['MASTER', 'ASISTENTE', 'PROFESIONAL']);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    },
  );

  it('allows SOPORTE when explicitly declared in metadata', () => {
    const { guard, context } = setup('SOPORTE', ['MASTER', 'SOPORTE']);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('leaves to the permission guard a role that can be granted the route permission', () => {
    const reflector = new Reflector();
    const metadata: Record<string, unknown> = {
      [ROLES_KEY]: ['MASTER', 'PROFESIONAL'],
      [REQUIRE_PERMISSION_KEY]: 'billing.view',
    };
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => metadata[key as string]);
    const contextFor = (role: string) =>
      ({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as unknown as ExecutionContext;
    const guard = new RolesGuard(reflector);

    expect(guard.canActivate(contextFor('ASISTENTE'))).toBe(true);
    // No one can be granted a clinical permission, so the role list stays final for it.
    metadata[REQUIRE_PERMISSION_KEY] = 'clinical_records.view';
    expect(() => guard.canActivate(contextFor('ASISTENTE'))).toThrow(ForbiddenException);
    // A role that cannot receive the permission is refused as before.
    metadata[REQUIRE_PERMISSION_KEY] = 'billing.view';
    expect(() => guard.canActivate(contextFor('SOPORTE'))).toThrow(ForbiddenException);
  });

  describe('a role outside the list on a permission-guarded route', () => {
    const run = (role: string, roles: string[], permission?: string) => {
      const reflector = new Reflector();
      const metadata: Record<string, unknown> = {
        [ROLES_KEY]: roles,
        [REQUIRE_PERMISSION_KEY]: permission,
      };
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockImplementation((key) => metadata[key as string]);
      const context = {
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext;
      return () => new RolesGuard(reflector).canActivate(context);
    };

    it('lets a cashier through when the permission is one of its role', () => {
      expect(run('CAJERO', ['MASTER'], 'billing.view')()).toBe(true);
      expect(run('CAJERO', ['MASTER'], 'cash.manage')()).toBe(true);
    });

    it('lets a cashier through for a grantable permission, as an assistant', () => {
      expect(run('CAJERO', ['MASTER'], 'inventory.manage')()).toBe(true);
      expect(run('ASISTENTE', ['MASTER'], 'billing.view')()).toBe(true);
    });

    it('keeps a route without a permission closed to a cashier', () => {
      expect(run('CAJERO', ['MASTER'])).toThrow(ForbiddenException);
    });

    it('keeps clinical routes closed to a cashier', () => {
      expect(run('CAJERO', ['MASTER', 'PROFESIONAL'], 'clinical_records.view')).toThrow(
        ForbiddenException,
      );
      expect(run('CAJERO', ['MASTER', 'ASISTENTE', 'PROFESIONAL'], 'patients.create')).toThrow(
        ForbiddenException,
      );
    });

    it('does not open a route to a role whose default permissions lack it', () => {
      expect(run('ASISTENTE', ['MASTER'], 'billing.view')()).toBe(true); // grantable only
      expect(run('ASISTENTE', ['MASTER', 'PROFESIONAL'], 'clinical_records.view')).toThrow(
        ForbiddenException,
      );
      expect(run('SOPORTE', ['MASTER'], 'billing.view')).toThrow(ForbiddenException);
    });
  });

  it('allows a public route without a user', () => {
    const { guard, context } = setup(undefined, ['MASTER'], true);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a route without role metadata', () => {
    const { guard, context } = setup(undefined);
    expect(guard.canActivate(context)).toBe(true);
  });
});
