import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { AppointmentsController } from '../../appointments/appointments.controller';
import { BillingController } from '../../billing/billing.controller';
import { ClinicalNotesController } from '../../clinical-notes/clinical-notes.controller';
import { ClinicalTimelineController } from '../../clinical-timeline/clinical-timeline.controller';
import { ConsentTemplatesController } from '../../consents/consent-templates.controller';
import { EncountersController } from '../../encounters/encounters.controller';
import { NextSessionPlansController } from '../../next-session-plans/next-session-plans.controller';
import { PatientFilesController } from '../../patient-files/patient-files.controller';
import { PatientsController } from '../../patients/patients.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RecordDocumentsController } from '../../record-documents/record-documents.controller';
import { SpecialtyRecordsController } from '../../specialty-records/specialty-records.controller';
import { ConsentDocumentsController } from '../../treatment-sessions/consent-documents.controller';
import { TreatmentSessionsController } from '../../treatment-sessions/treatment-sessions.controller';
import { BillingProfilesController } from '../../billing-profiles/billing-profiles.controller';
import { TreatmentsController } from '../../treatments/treatments.controller';
import { UserPermissionsService } from '../../users/user-permissions.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PermissionGuard } from '../guards/permission.guard';
import {
  effectivePermissions,
  grantablePermissions,
  Permission,
  PERMISSION_CATALOG,
  REQUIRE_PERMISSION_KEY,
  RequirePermission,
  rolePermissions,
} from './permission-catalog';
import { PermissionChecker } from './permission-checker.service';

type Controller = { name: string; prototype: object };

const controllers: Controller[] = [
  PatientsController,
  AppointmentsController,
  BillingController,
  SpecialtyRecordsController,
  ClinicalNotesController,
  EncountersController,
  ClinicalTimelineController,
  NextSessionPlansController,
  PatientFilesController,
  RecordDocumentsController,
  ConsentTemplatesController,
  TreatmentsController,
  BillingProfilesController,
  TreatmentSessionsController,
  ConsentDocumentsController,
];

/** Every handler that names a permission, with the roles the role guard lets through. */
const guardedHandlers = controllers.flatMap((controller) =>
  Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
    const handler = (controller.prototype as Record<string, object>)[name];
    const permission: Permission | undefined =
      typeof handler === 'function'
        ? Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)
        : undefined;
    if (!permission) return [];
    const roles: string[] =
      Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller) ?? [];
    return [{ route: `${controller.name}.${name}`, permission, roles }];
  }),
);

describe('permission catalog', () => {
  it('gives each role only the permissions the catalog lists for it', () => {
    expect(rolePermissions('ASISTENTE')).toEqual([
      'patients.create',
      'patients.update',
      'appointments.create',
      'appointments.update',
      'appointments.cancel',
    ]);
    expect(rolePermissions('MASTER')).toHaveLength(PERMISSION_CATALOG.length);
    expect(rolePermissions('PACIENTE')).toEqual([]);
    expect(rolePermissions('PSICOLOGO')).toEqual([]);
  });

  it('adds what was granted only to a role that can receive it', () => {
    expect(grantablePermissions('ASISTENTE')).toEqual([
      'billing.view',
      'billing.create',
      'treatments.manage',
      'billing.adjust',
      'cash.manage',
    ]);
    expect(grantablePermissions('PROFESIONAL')).toEqual([
      'billing.view',
      'billing.create',
      'treatments.manage',
      'billing.adjust',
      'cash.manage',
    ]);
    expect(effectivePermissions('ASISTENTE', [], ['billing.view'])).toContain('billing.view');
    expect(effectivePermissions('ASISTENTE', [], ['clinical_records.view'])).not.toContain(
      'clinical_records.view',
    );
  });

  it('keeps treatment and consent management with the account holder unless it is granted', () => {
    expect(rolePermissions('MASTER')).toContain('treatments.manage');
    expect(rolePermissions('PROFESIONAL')).not.toContain('treatments.manage');
    expect(rolePermissions('ASISTENTE')).not.toContain('treatments.manage');
    expect(grantablePermissions('PROFESIONAL')).toContain('treatments.manage');
    expect(grantablePermissions('ASISTENTE')).toContain('treatments.manage');
    expect(effectivePermissions('ASISTENTE', [], ['treatments.manage'])).toContain(
      'treatments.manage',
    );
    expect(effectivePermissions('ASISTENTE', [])).not.toContain('treatments.manage');
  });

  it('keeps billing and the cash register with the account holder unless they are granted', () => {
    const keys = ['billing.view', 'billing.create', 'billing.adjust', 'cash.manage'];

    expect(rolePermissions('MASTER')).toEqual(expect.arrayContaining(keys));
    for (const role of ['PROFESIONAL', 'ASISTENTE']) {
      for (const key of keys) {
        expect(rolePermissions(role)).not.toContain(key);
        expect(grantablePermissions(role)).toContain(key);
        expect(effectivePermissions(role, [], [key])).toContain(key);
      }
    }
  });

  it('removes what was withdrawn, except from the account holder', () => {
    expect(effectivePermissions('ASISTENTE', ['appointments.cancel', 'billing.view'])).toEqual([
      'patients.create',
      'patients.update',
      'appointments.create',
      'appointments.update',
    ]);
    expect(effectivePermissions('MASTER', ['billing.create'])).toContain('billing.create');
  });

  it('is exercised by at least one route for every permission', () => {
    const used = new Set(guardedHandlers.map(({ permission }) => permission));
    // Permissions whose routes arrive with the later B1 tasks (cash registers, orders, payments).
    const notRoutedYet: Permission[] = ['billing.adjust', 'cash.manage'];

    expect([...used, ...notRoutedYet].sort()).toEqual(
      PERMISSION_CATALOG.map(({ key }) => key).sort(),
    );
  });

  it.each(guardedHandlers)(
    '$route ($permission) is open only to roles that have the permission',
    ({ permission, roles }) => {
      const allowed = PERMISSION_CATALOG.find((entry) => entry.key === permission)!.roles;

      expect(roles.length).toBeGreaterThan(0);
      for (const role of roles) expect(allowed).toContain(role);
    },
  );

  it('leaves no @RequirePermission in a controller this spec does not check', () => {
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return files(full);
        return entry.name.endsWith('.controller.ts') ? [full] : [];
      });
    const annotated = files(path.join(__dirname, '../..'))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('@RequirePermission('))
      .map((file) => path.basename(file));

    expect(annotated.sort()).toEqual(
      [
        'appointments.controller.ts',
        'billing-profiles.controller.ts',
        'billing.controller.ts',
        'clinical-notes.controller.ts',
        'clinical-timeline.controller.ts',
        'consent-documents.controller.ts',
        'consent-templates.controller.ts',
        'encounters.controller.ts',
        'next-session-plans.controller.ts',
        'patient-files.controller.ts',
        'patients.controller.ts',
        'record-documents.controller.ts',
        'specialty-records.controller.ts',
        'treatments.controller.ts',
        'treatment-sessions.controller.ts',
      ].sort(),
    );
  });
});

describe('PermissionGuard', () => {
  class Routes {
    @RequirePermission('patients.create')
    guarded() {}
    @RequirePermission('billing.create')
    restricted() {}
    open() {}
  }
  const db = { userPermission: { findFirst: jest.fn() } };
  const guard = new PermissionGuard(
    new Reflector(),
    new PermissionChecker(db as unknown as PrismaService),
  );
  const context = (handler: 'guarded' | 'restricted' | 'open', user?: object, isPublic = false) => {
    const fn = Routes.prototype[handler];
    Reflect.defineMetadata(IS_PUBLIC_KEY, isPublic, fn);
    return {
      getHandler: () => fn,
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  };
  const professional = { userId: 'user-1', tenantId: 'tenant-1', role: 'PROFESIONAL' };

  beforeEach(() => jest.resetAllMocks());

  it('lets a user through when nothing was withdrawn', async () => {
    db.userPermission.findFirst.mockResolvedValue(null);

    await expect(guard.canActivate(context('guarded', professional))).resolves.toBe(true);
    expect(db.userPermission.findFirst.mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      tenantId: 'tenant-1',
      permission: 'patients.create',
      granted: false,
    });
  });

  it('refuses a user whose permission was withdrawn', async () => {
    db.userPermission.findFirst.mockResolvedValue({ id: 'row' });

    await expect(guard.canActivate(context('guarded', professional))).rejects.toMatchObject({
      status: 403,
      response: { code: 'PERMISSION_DENIED', permission: 'patients.create' },
    });
  });

  it('lets a role outside the route through only with the permission granted', async () => {
    const assistant = { ...professional, role: 'ASISTENTE' };
    db.userPermission.findFirst.mockResolvedValueOnce(null);
    await expect(guard.canActivate(context('restricted', assistant))).rejects.toMatchObject({
      status: 403,
      response: { code: 'PERMISSION_DENIED', permission: 'billing.create' },
    });
    expect(db.userPermission.findFirst.mock.calls[0][0].where).toMatchObject({
      permission: 'billing.create',
      granted: true,
    });

    db.userPermission.findFirst.mockResolvedValueOnce({ id: 'grant' });
    await expect(guard.canActivate(context('restricted', assistant))).resolves.toBe(true);
  });

  it('never restricts the account holder and never queries for unguarded or public routes', async () => {
    await expect(
      guard.canActivate(context('guarded', { ...professional, role: 'MASTER' })),
    ).resolves.toBe(true);
    await expect(guard.canActivate(context('open', professional))).resolves.toBe(true);
    await expect(guard.canActivate(context('guarded', undefined, true))).resolves.toBe(true);

    expect(db.userPermission.findFirst).not.toHaveBeenCalled();
  });
});

describe('UserPermissionsService', () => {
  const db = {
    user: { findFirst: jest.fn() },
    userPermission: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const service = new UserPermissionsService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.user.findFirst.mockResolvedValue({ id: 'user-1', role: 'ASISTENTE' });
    db.userPermission.findMany.mockResolvedValue([]);
  });

  it('describes the permissions of the role and which ones the user still has', async () => {
    db.userPermission.findMany.mockResolvedValue([
      { permission: 'appointments.cancel', granted: false },
      { permission: 'billing.view', granted: true },
      // A grant the role cannot receive is ignored, whatever the table holds.
      { permission: 'clinical_records.view', granted: true },
    ]);

    const described = await service.describe('tenant-1', 'user-1');

    expect(db.user.findFirst.mock.calls[0][0].where).toEqual({
      id: 'user-1',
      tenantId: 'tenant-1',
    });
    expect(described.restrictable).toBe(true);
    expect(described.permissions.map(({ key, allowed, source }) => [key, allowed, source])).toEqual(
      [
        ['patients.create', true, 'role'],
        ['patients.update', true, 'role'],
        ['appointments.create', true, 'role'],
        ['appointments.update', true, 'role'],
        ['appointments.cancel', false, 'role'],
        ['billing.view', true, 'grant'],
        ['billing.create', false, 'grant'],
        ['treatments.manage', false, 'grant'],
        ['billing.adjust', false, 'grant'],
        ['cash.manage', false, 'grant'],
      ],
    );
    expect(described.effective).not.toContain('appointments.cancel');
    expect(described.effective).toContain('billing.view');
    expect(described.effective).not.toContain('clinical_records.view');
  });

  it('gives a user permissions their role can receive', async () => {
    await service.replace(
      'tenant-1',
      'user-1',
      'master',
      ['appointments.cancel'],
      ['billing.view'],
    );

    expect(db.userPermission.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ permission: 'appointments.cancel', granted: false }),
      expect.objectContaining({ permission: 'billing.view', granted: true, createdById: 'master' }),
    ]);
  });

  it('refuses to grant what the role cannot receive', async () => {
    await expect(
      service.replace('tenant-1', 'user-1', 'master', [], ['clinical_records.view']),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PERMISSION_INVALID' } });
    // A professional already has patient registration by role: there is nothing to grant.
    db.user.findFirst.mockResolvedValue({ id: 'user-1', role: 'PROFESIONAL' });
    await expect(
      service.replace('tenant-1', 'user-1', 'master', [], ['patients.create']),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PERMISSION_INVALID' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('replaces the withdrawn permissions of the user', async () => {
    await service.replace('tenant-1', 'user-1', 'master', [
      'appointments.cancel',
      'appointments.cancel',
    ]);

    expect(db.userPermission.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', userId: 'user-1' },
    });
    expect(db.userPermission.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: 'tenant-1',
          userId: 'user-1',
          permission: 'appointments.cancel',
          granted: false,
          createdById: 'master',
        },
      ],
    });
  });

  it('restores every permission with an empty list', async () => {
    await service.replace('tenant-1', 'user-1', 'master', []);

    expect(db.userPermission.deleteMany).toHaveBeenCalled();
    expect(db.userPermission.createMany).not.toHaveBeenCalled();
  });

  it('refuses unknown permissions and ones the role does not have', async () => {
    await expect(
      service.replace('tenant-1', 'user-1', 'master', ['patients.destroy']),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PERMISSION_INVALID' } });
    await expect(
      service.replace('tenant-1', 'user-1', 'master', ['billing.create']),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PERMISSION_INVALID' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('never restricts the account holder nor a user of another tenant', async () => {
    db.user.findFirst.mockResolvedValueOnce({ id: 'master', role: 'MASTER' });
    await expect(
      service.replace('tenant-1', 'master', 'master', ['billing.create']),
    ).rejects.toMatchObject({ status: 409, response: { code: 'PERMISSIONS_NOT_RESTRICTABLE' } });

    db.user.findFirst.mockResolvedValueOnce(null);
    await expect(service.replace('tenant-1', 'foreign', 'master', [])).rejects.toMatchObject({
      status: 404,
    });
  });
});
