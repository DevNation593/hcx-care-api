import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { RlsContextService } from '../prisma/rls-context.service';
import { SpecialtiesController } from './specialties.controller';
import { SpecialtiesService } from './specialties.service';
import { TenantSpecialtiesService } from './tenant-specialties.service';

describe('SpecialtiesController selection routes', () => {
  let app: INestApplication;
  const result = {
    tenantId: 'tenant-1',
    specialties: [],
    modules: [],
    pricing: { totalMonthly: 99 },
  };
  const selection = { replace: jest.fn().mockResolvedValue(result), updateModule: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SpecialtiesController],
      providers: [
        {
          provide: SpecialtiesService,
          useValue: { listForTenant: jest.fn(), listModulesForTenant: jest.fn() },
        },
        { provide: TenantSpecialtiesService, useValue: selection },
        { provide: RlsContextService, useValue: { set: jest.fn() } },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req, _res, next) => {
      if (req.headers['x-test-role'])
        req.user = { userId: 'admin-1', tenantId: 'tenant-1', role: req.headers['x-test-role'] };
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => selection.replace.mockClear());

  it.each(['put', 'post'] as const)(
    '%s refuses specialty selection from the clinic master',
    async (method) => {
      await request(app.getHttpServer())
        [method]('/tenants/tenant-1/specialties')
        .set('x-test-role', 'MASTER')
        .send({ specialtyCodes: [' psychology '] })
        .expect(404);
      expect(selection.replace).not.toHaveBeenCalled();
    },
  );

  it.each([[[]], [['PSYCHOLOGY', 7]], [['  ']]])(
    'rejects invalid selection %j before service',
    async (specialtyCodes) => {
      await request(app.getHttpServer())
        .put('/tenants/tenant-1/specialties')
        .set('x-test-role', 'MASTER')
        .send({ specialtyCodes })
        .expect(404);
      expect(selection.replace).not.toHaveBeenCalled();
    },
  );

  it('enforces tenant scope and administrative role on both routes', async () => {
    for (const method of ['put', 'post'] as const) {
      await request(app.getHttpServer())
        [method]('/tenants/tenant-2/specialties')
        .set('x-test-role', 'MASTER')
        .send({ specialtyCodes: ['PSYCHOLOGY'] })
        .expect(404);
      await request(app.getHttpServer())
        [method]('/tenants/tenant-1/specialties')
        .set('x-test-role', 'PROFESIONAL')
        .send({ specialtyCodes: ['PSYCHOLOGY'] })
        .expect(404);
    }
    expect(selection.replace).not.toHaveBeenCalled();
  });

  it('does not register a tenant module mutation route', async () => {
    await request(app.getHttpServer())
      .patch('/tenants/tenant-1/modules/psychology.assessments')
      .set('x-test-role', 'MASTER')
      .send({ enabled: true })
      .expect(404);
    expect(selection.updateModule).not.toHaveBeenCalled();
  });
});
