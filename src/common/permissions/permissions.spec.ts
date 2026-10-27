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
import { CashRegistersController } from '../../cash-registers/cash-registers.controller';
import { OrdersController } from '../../orders/orders.controller';
import { ProductsController } from '../../inventory/products.controller';
import { StockController } from '../../inventory/stock.controller';
import { InventoryReportsController } from '../../inventory/inventory-reports.controller';
import { InvoicingController } from '../../invoicing/invoicing.controller';
import { TreatmentsController } from '../../treatments/treatments.controller';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PermissionGuard } from '../guards/permission.guard';
import { RolesGuard } from '../guards/roles.guard';
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
  CashRegistersController,
  OrdersController,
  ProductsController,
  StockController,
  InventoryReportsController,
  InvoicingController,
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
      'inventory.manage',
    ]);
    expect(grantablePermissions('PROFESIONAL')).toEqual([
      'billing.view',
      'billing.create',
      'treatments.manage',
      'billing.adjust',
      'cash.manage',
      'inventory.manage',
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

  it('keeps inventory management with the account holder unless it is granted', () => {
    expect(rolePermissions('MASTER')).toContain('inventory.manage');
    expect(rolePermissions('ASISTENTE')).not.toContain('inventory.manage');
    expect(grantablePermissions('ASISTENTE')).toContain('inventory.manage');
    expect(grantablePermissions('PROFESIONAL')).toContain('inventory.manage');
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

  it('gives the cashier billing and the cash register, and only inventory on request', () => {
    expect(rolePermissions('CAJERO')).toEqual([
      'billing.view',
      'billing.create',
      'billing.adjust',
      'cash.manage',
    ]);
    expect(grantablePermissions('CAJERO')).toEqual(['inventory.manage']);

    const clinical = PERMISSION_CATALOG.filter(
      ({ key }) =>
        key.startsWith('patients.') ||
        key.startsWith('appointments.') ||
        key.startsWith('clinical_records.') ||
        key === 'treatments.manage',
    );
    expect(clinical.length).toBeGreaterThan(0);
    for (const entry of clinical) {
      expect(entry.roles as readonly string[]).not.toContain('CAJERO');
      expect((entry as { grantable?: readonly string[] }).grantable ?? []).not.toContain('CAJERO');
    }
  });

  it('removes what the platform withdrew from a clinic role, including MASTER', () => {
    expect(effectivePermissions('ASISTENTE', ['appointments.cancel', 'billing.view'])).toEqual([
      'patients.create',
      'patients.update',
      'appointments.create',
      'appointments.update',
    ]);
    expect(effectivePermissions('MASTER', ['billing.create'])).not.toContain('billing.create');
  });

  it('is exercised by at least one route for every permission', () => {
    const used = new Set(guardedHandlers.map(({ permission }) => permission));
    expect([...used].sort()).toEqual(PERMISSION_CATALOG.map(({ key }) => key).sort());
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
        'cash-registers.controller.ts',
        'clinical-notes.controller.ts',
        'clinical-timeline.controller.ts',
        'consent-documents.controller.ts',
        'consent-templates.controller.ts',
        'encounters.controller.ts',
        'inventory-reports.controller.ts',
        'invoicing.controller.ts',
        'next-session-plans.controller.ts',
        'orders.controller.ts',
        'patient-files.controller.ts',
        'patients.controller.ts',
        'products.controller.ts',
        'record-documents.controller.ts',
        'stock.controller.ts',
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
  const db = { tenantRolePermission: { findFirst: jest.fn() } };
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
    db.tenantRolePermission.findFirst.mockResolvedValue(null);

    await expect(guard.canActivate(context('guarded', professional))).resolves.toBe(true);
    expect(db.tenantRolePermission.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant-1',
      role: 'PROFESIONAL',
      permission: 'patients.create',
      granted: false,
    });
  });

  it('refuses a user whose permission was withdrawn', async () => {
    db.tenantRolePermission.findFirst.mockResolvedValue({ id: 'row' });

    await expect(guard.canActivate(context('guarded', professional))).rejects.toMatchObject({
      status: 403,
      response: { code: 'PERMISSION_DENIED', permission: 'patients.create' },
    });
  });

  it('lets a role outside the route through only with the permission granted', async () => {
    const assistant = { ...professional, role: 'ASISTENTE' };
    db.tenantRolePermission.findFirst.mockResolvedValueOnce(null);
    await expect(guard.canActivate(context('restricted', assistant))).rejects.toMatchObject({
      status: 403,
      response: { code: 'PERMISSION_DENIED', permission: 'billing.create' },
    });
    expect(db.tenantRolePermission.findFirst.mock.calls[0][0].where).toMatchObject({
      permission: 'billing.create',
      granted: true,
    });

    db.tenantRolePermission.findFirst.mockResolvedValueOnce({ id: 'grant' });
    await expect(guard.canActivate(context('restricted', assistant))).resolves.toBe(true);
  });

  it('refuses a cashier whose own permission was withdrawn, and lets the others through', async () => {
    const cashier = { ...professional, role: 'CAJERO' };
    db.tenantRolePermission.findFirst.mockResolvedValueOnce({ id: 'withdrawn' });
    await expect(guard.canActivate(context('restricted', cashier))).rejects.toMatchObject({
      status: 403,
      response: { code: 'PERMISSION_DENIED', permission: 'billing.create' },
    });
    expect(db.tenantRolePermission.findFirst.mock.calls[0][0].where).toMatchObject({
      role: 'CAJERO',
      permission: 'billing.create',
      granted: false,
    });

    db.tenantRolePermission.findFirst.mockResolvedValueOnce(null);
    await expect(guard.canActivate(context('restricted', cashier))).resolves.toBe(true);
  });

  it('refuses an assistant without the billing.view grant on GET /orders, through both guards', async () => {
    const handler = OrdersController.prototype.list;
    const orders = {
      getHandler: () => handler,
      getClass: () => OrdersController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { ...professional, role: 'ASISTENTE' } }),
      }),
    } as unknown as ExecutionContext;

    // The role guard lets a grantable permission through; the permission guard decides.
    expect(new RolesGuard(new Reflector()).canActivate(orders)).toBe(true);
    db.tenantRolePermission.findFirst.mockResolvedValueOnce(null);
    await expect(guard.canActivate(orders)).rejects.toMatchObject({
      status: 403,
      response: { code: 'PERMISSION_DENIED', permission: 'billing.view' },
    });
  });

  it('does not query for unguarded or public routes', async () => {
    await expect(guard.canActivate(context('open', professional))).resolves.toBe(true);
    await expect(guard.canActivate(context('guarded', undefined, true))).resolves.toBe(true);

    expect(db.tenantRolePermission.findFirst).not.toHaveBeenCalled();
  });
});
