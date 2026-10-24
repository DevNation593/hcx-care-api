import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AuthService } from './../src/auth/auth.service';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(30000);

describe('Master role (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let masterId: string;
  let token: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get<PrismaService>(PrismaService);

    await prisma.cleanDatabase();
    const tenant = await createTestTenant({ tenants: app.get(PlatformTenantsService), prisma }, 1);
    tenantId = tenant.id;

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'admin+1@tenant.test', password: TEST_PASSWORD })
      .expect(200);
    token = login.body.accessToken;

    const owner = await prisma.user.findFirstOrThrow({ where: { tenantId } });
    masterId = owner.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates the clinic owner as the only MASTER', async () => {
    const owners = await prisma.user.findMany({ where: { tenantId }, select: { role: true } });
    expect(owners).toEqual([{ role: 'MASTER' }]);
  });

  it.each(['MASTER', 'ADMIN'])('refuses to create a %s team member', async (role) => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/tenants/${tenantId}/users`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `extra-${role.toLowerCase()}@tenant.test`,
        password: TEST_PASSWORD,
        firstName: 'Extra',
        lastName: 'User',
        role,
      })
      .expect(400);
    expect(response.body.code).toBe('ROLE_NOT_ASSIGNABLE');
  });

  it('refuses to deactivate the MASTER', async () => {
    const response = await request(app.getHttpServer())
      .delete(`/api/v1/tenants/${tenantId}/users/${masterId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
    expect(response.body.code).toBe('MASTER_IMMUTABLE');
  });

  it('refuses to demote the MASTER', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/tenants/${tenantId}/users/${masterId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'ASISTENTE' })
      .expect(400);
    expect(response.body.code).toBe('MASTER_IMMUTABLE');
  });

  it('rejects a second MASTER at the database level', async () => {
    await expect(
      prisma.user.create({
        data: {
          tenantId,
          email: 'second-master@tenant.test',
          password: 'not-a-real-hash',
          firstName: 'Second',
          lastName: 'Master',
          role: 'MASTER',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
  describe('role sweeps on MASTER-only endpoints', () => {
    type Route = [method: 'post' | 'put' | 'patch' | 'delete' | 'get', path: string];
    const masterOnly = (id: string): Route[] => [
      ['post', `/api/v1/tenants/${id}/users`],
      ['patch', `/api/v1/tenants/${id}/users/placeholder-user`],
      ['delete', `/api/v1/tenants/${id}/users/placeholder-user`],
      ['patch', `/api/v1/tenants/${id}`],
      ['patch', `/api/v1/tenants/${id}/settings`],
      ['get', `/api/v1/tenants/${id}/audit-logs`],
      ['delete', `/api/v1/tenants/${id}/patients/placeholder-patient`],
      ['delete', `/api/v1/tenants/${id}/tasks/placeholder-task`],
    ];
    const tokens: Record<'PROFESIONAL' | 'ADMIN', string> = { PROFESIONAL: '', ADMIN: '' };

    beforeAll(async () => {
      const password = await app.get<AuthService>(AuthService).hashPassword(TEST_PASSWORD);
      for (const role of ['PROFESIONAL', 'ADMIN'] as const) {
        const email = `${role.toLowerCase()}-sweep@tenant.test`;
        await prisma.user.create({
          data: {
            tenantId,
            email,
            password,
            firstName: role,
            lastName: 'Sweep',
            role,
            isActive: true,
          },
        });
        const login = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email, password: TEST_PASSWORD })
          .expect(200);
        tokens[role] = login.body.accessToken;
      }
    });

    const call = (method: Route[0], path: string, bearer: string) =>
      request(app.getHttpServer())[method](path).set('Authorization', `Bearer ${bearer}`).send({});

    it.each([
      ['post', '/api/v1/tenants/TENANT/subscription/features'],
      ['put', '/api/v1/tenants/TENANT/specialties'],
      ['post', '/api/v1/tenants/TENANT/specialties'],
      ['patch', '/api/v1/tenants/TENANT/modules/placeholder-module'],
      ['put', '/api/v1/tenants/TENANT/users/me/permissions'],
    ] as Route[])('the former clinic assignment route %s %s is gone', async (method, path) => {
      await call(method, path.replace('TENANT', tenantId), token).expect(404);
    });

    it.each(masterOnly('TENANT'))('a PROFESIONAL gets 403 on %s %s', async (method, path) => {
      await call(method, path.replace('TENANT', tenantId), tokens.PROFESIONAL).expect(403);
    });

    it.each([...masterOnly('TENANT'), ['get', '/api/v1/tenants/TENANT/appointments'] as Route])(
      'an ADMIN of the tenant gets 403 on %s %s',
      async (method, path) => {
        await call(method, path.replace('TENANT', tenantId), tokens.ADMIN).expect(403);
      },
    );
  });
});
