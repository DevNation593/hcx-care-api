import * as fs from 'fs';
import * as path from 'path';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ClinicalNotesController } from '../../clinical-notes/clinical-notes.controller';
import { NextSessionPlansController } from '../../next-session-plans/next-session-plans.controller';
import {
  grantablePermissions,
  Permission,
  REQUIRE_PERMISSION_KEY,
  rolePermissions,
} from '../permissions/permission-catalog';
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

    it('refuses clinical routes to a role without the permission, and passes a grantable one', () => {
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

describe('RolesGuard against the real route metadata', () => {
  const guard = new RolesGuard(new Reflector());
  const contextFor = (controller: { prototype: object }, handler: string, role: string) =>
    ({
      getHandler: () => (controller.prototype as unknown as Record<string, object>)[handler],
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as unknown as ExecutionContext;

  it('refuses MASTER and ASISTENTE on the professional-only clinical writes', () => {
    for (const [c, h] of [
      [ClinicalNotesController, 'create'],
      [ClinicalNotesController, 'update'],
      [NextSessionPlansController, 'create'],
      [NextSessionPlansController, 'update'],
    ] as const) {
      const handler = (c.prototype as unknown as Record<string, object>)[h];
      const roles: string[] =
        Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, c);
      expect(roles).not.toContain('MASTER');
      expect(() => guard.canActivate(contextFor(c, h, 'MASTER'))).toThrow(ForbiddenException);
      expect(() => guard.canActivate(contextFor(c, h, 'ASISTENTE'))).toThrow(ForbiddenException);
    }
  });

  it('admits a clinic role outside @Roles only for a grantable permission, or the cashier own one', () => {
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return files(full);
        return entry.name.endsWith('.controller.ts') ? [full] : [];
      });
    let checked = 0;

    for (const file of files(path.resolve(__dirname, '../..'))) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      for (const value of Object.values(require(file)) as unknown[]) {
        if (typeof value !== 'function' || !value.prototype) continue;
        const controller = value as { name: string; prototype: object };
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = (controller.prototype as Record<string, unknown>)[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const roles: string[] | undefined =
            Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller);
          const permission: Permission | undefined =
            Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler) ??
            Reflect.getMetadata(REQUIRE_PERMISSION_KEY, controller);
          if (!roles?.length) continue;

          for (const role of ['MASTER', 'PROFESIONAL', 'ASISTENTE', 'CAJERO']) {
            if (roles.includes(role)) continue;
            const expected =
              !!permission &&
              (grantablePermissions(role).includes(permission) ||
                (role === 'CAJERO' && rolePermissions(role).includes(permission)));
            let admitted = true;
            try {
              guard.canActivate({
                getHandler: () => handler,
                getClass: () => controller,
                switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
              } as unknown as ExecutionContext);
            } catch (error) {
              if (!(error instanceof ForbiddenException)) throw error;
              admitted = false;
            }
            expect({ route: `${controller.name}.${name}`, role, admitted }).toEqual({
              route: `${controller.name}.${name}`,
              role,
              admitted: expected,
            });
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
