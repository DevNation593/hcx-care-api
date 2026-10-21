import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { TenantGuard } from '../common/guards/tenant.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { RlsContextService } from '../prisma/rls-context.service';
import { UserPermissionsController } from '../users/user-permissions.controller';
import { UserPermissionsService } from '../users/user-permissions.service';
import { TenantSpecialtiesService } from '../specialties/tenant-specialties.service';
import { SpecialtyCatalogService } from '../specialties/specialty-catalog.service';
import { PlatformRolePermissionsService } from './platform-role-permissions.service';
import { PlatformSubscriptionService } from './platform-subscription.service';
import { PlatformTenantsController } from './platform-tenants.controller';
import { PlatformTenantsService } from './platform-tenants.service';

describe('platform access routes', () => {
  let app: INestApplication;
  const roles = { describe: jest.fn(), replace: jest.fn() };
  const personal = { describe: jest.fn(), replace: jest.fn() };
  const modules = { replace: jest.fn(), updateModule: jest.fn() };
  const catalog = { listActive: jest.fn() };
  const tenants = { findOne: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlatformTenantsController, UserPermissionsController],
      providers: [
        {
          provide: PlatformTenantsService,
          useValue: tenants,
        },
        { provide: PlatformSubscriptionService, useValue: {} },
        { provide: PlatformRolePermissionsService, useValue: roles },
        { provide: UserPermissionsService, useValue: personal },
        { provide: TenantSpecialtiesService, useValue: modules },
        { provide: SpecialtyCatalogService, useValue: catalog },
        { provide: RlsContextService, useValue: { set: jest.fn() } },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req, _res, next) => {
      req.user =
        req.headers['x-test-role'] === 'ADMIN'
          ? { userId: 'owner-1', tenantId: 'platform-1', role: 'ADMIN', isPlatformTenant: true }
          : { userId: 'master-1', tenantId: 'clinic-1', role: 'MASTER', isPlatformTenant: false };
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => {
    jest.resetAllMocks();
    roles.replace.mockResolvedValue({ role: 'MASTER', effective: [] });
    roles.describe.mockResolvedValue({ role: 'MASTER', effective: [] });
    modules.replace.mockResolvedValue({ tenantId: 'clinic-1', specialties: [] });
    modules.updateModule.mockResolvedValue({ moduleKey: 'psychology.assessments', enabled: false });
    catalog.listActive.mockResolvedValue([{ code: 'PSYCHOLOGY', name: 'Psicología', modules: [] }]);
    tenants.findOne.mockResolvedValue({ tenant: { id: 'clinic-1', businessKind: 'MEDICAL' } });
  });

  it('lets only the platform owner set a clinic role and denies the clinic master', async () => {
    await request(app.getHttpServer())
      .put('/platform/tenants/clinic-1/roles/MASTER/permissions')
      .set('x-test-role', 'MASTER')
      .send({ allowed: ['patients.create'] })
      .expect(403);
    await request(app.getHttpServer())
      .put('/platform/tenants/clinic-1/roles/MASTER/permissions')
      .set('x-test-role', 'ADMIN')
      .send({ allowed: ['patients.create'] })
      .expect(200);
    expect(roles.replace).toHaveBeenCalledWith('clinic-1', 'MASTER', 'owner-1', [
      'patients.create',
    ]);
  });

  it('does not let the master save personal permission overrides', async () => {
    await request(app.getHttpServer())
      .put('/tenants/clinic-1/users/staff-1/permissions')
      .set('x-test-role', 'MASTER')
      .send({ revoked: ['billing.view'], granted: [] })
      .expect(404);
    expect(personal.replace).not.toHaveBeenCalled();
  });

  it('lets only the platform owner change clinical specialties and modules', async () => {
    await request(app.getHttpServer())
      .put('/platform/tenants/clinic-1/specialties')
      .set('x-test-role', 'MASTER')
      .send({ specialtyCodes: ['PSYCHOLOGY'] })
      .expect(403);
    await request(app.getHttpServer())
      .put('/platform/tenants/clinic-1/specialties')
      .set('x-test-role', 'ADMIN')
      .send({ specialtyCodes: ['PSYCHOLOGY'] })
      .expect(200);
    expect(modules.replace).toHaveBeenCalledWith('clinic-1', ['PSYCHOLOGY'], 'owner-1');

    await request(app.getHttpServer())
      .patch('/platform/tenants/clinic-1/modules/psychology.assessments')
      .set('x-test-role', 'ADMIN')
      .send({ enabled: false })
      .expect(200);
    expect(modules.updateModule).toHaveBeenCalledWith(
      'clinic-1',
      'psychology.assessments',
      false,
      'owner-1',
    );
  });

  it('does not assign medical specialties or modules to an aesthetic studio', async () => {
    tenants.findOne.mockResolvedValue({
      tenant: { id: 'clinic-1', businessKind: 'AESTHETIC_STUDIO' },
    });
    await request(app.getHttpServer())
      .put('/platform/tenants/clinic-1/specialties')
      .set('x-test-role', 'ADMIN')
      .send({ specialtyCodes: ['PSYCHOLOGY'] })
      .expect(400);
    await request(app.getHttpServer())
      .patch('/platform/tenants/clinic-1/modules/psychology.assessments')
      .set('x-test-role', 'ADMIN')
      .send({ enabled: true })
      .expect(400);
    expect(modules.replace).not.toHaveBeenCalled();
    expect(modules.updateModule).not.toHaveBeenCalled();
  });

  it('lists the specialty catalog for the platform panel', async () => {
    const specialties = await request(app.getHttpServer())
      .get('/platform/specialty-catalog')
      .set('x-test-role', 'ADMIN')
      .expect(200);
    expect(specialties.body[0].code).toBe('PSYCHOLOGY');
  });
});
