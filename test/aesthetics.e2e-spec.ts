import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';

jest.setTimeout(120000);

describe('Aesthetic studio workflow (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = (path: string) => `/api/v1${path}`;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const http = () => request(app.getHttpServer());
  const password = 'Temporal-2026!';

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = fixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.cleanDatabase();
    const platform = await prisma.tenant.create({
      data: { name: 'Platform', email: 'platform@aesthetic.test', isPlatform: true },
    });
    await prisma.user.create({
      data: {
        tenantId: platform.id,
        email: 'admin@aesthetic.test',
        password: await app.get(AuthService).hashPassword(password),
        firstName: 'Platform',
        lastName: 'Admin',
        role: 'ADMIN',
        isActive: true,
      },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('keeps medical routes out and completes the studio flow with an owner-assigned role', async () => {
    const adminLogin = await http()
      .post(api('/auth/login'))
      .send({ email: 'admin@aesthetic.test', password })
      .expect(200);
    const adminToken = adminLogin.body.accessToken as string;
    const createStudio = (suffix: string) =>
      http()
        .post(api('/platform/tenants'))
        .set(auth(adminToken))
        .send({
          name: `Estudio ${suffix}`,
          email: `estudio-${suffix}@aesthetic.test`,
          tenantType: 'CLINIC',
          businessKind: 'AESTHETIC_STUDIO',
          timezone: 'America/Guayaquil',
          locale: 'es',
          masterFirstName: 'Ana',
          masterLastName: suffix,
          masterEmail: `ana-${suffix}@aesthetic.test`,
          temporaryPassword: password,
          planType: 'TRIAL',
          specialtyCodes: [],
          sections: ['core.team', 'core.aesthetics'],
        });
    const created = await createStudio('uno').expect(201);
    const tenantId = created.body.tenant.id as string;
    const second = await createStudio('dos').expect(201);
    const otherTenantId = second.body.tenant.id as string;
    const login = await http()
      .post(api('/auth/login'))
      .send({ email: 'ana-uno@aesthetic.test', password })
      .expect(200);
    const masterToken = login.body.accessToken as string;
    await http()
      .post(api('/auth/change-password'))
      .set(auth(masterToken))
      .send({ currentPassword: password, newPassword: 'Definitiva-2026!' })
      .expect(200);
    const base = api(`/tenants/${tenantId}/aesthetics`);

    await http()
      .get(api(`/tenants/${tenantId}/patients`))
      .set(auth(masterToken))
      .expect(403);
    await http()
      .put(api(`/platform/tenants/${tenantId}/specialties`))
      .set(auth(adminToken))
      .send({ specialtyCodes: ['PSYCHOLOGY'] })
      .expect(400);
    await http()
      .get(api(`/tenants/${otherTenantId}/aesthetics/clients`))
      .set(auth(masterToken))
      .expect(403);

    const professional = await http()
      .post(api(`/tenants/${tenantId}/users`))
      .set(auth(masterToken))
      .send({
        email: 'profesional@aesthetic.test',
        password,
        firstName: 'Elena',
        lastName: 'Paz',
        role: 'PROFESIONAL',
      })
      .expect(201);
    expect(professional.body.professionalProfile).toBeFalsy();

    const client = await http()
      .post(`${base}/clients`)
      .set(auth(masterToken))
      .send({ firstName: 'Lucía', lastName: 'Mora', phone: '0991234567' })
      .expect(201);
    const service = await http()
      .post(`${base}/services`)
      .set(auth(masterToken))
      .send({
        name: 'Tratamiento facial',
        durationMinutes: 60,
        price: 40,
        consentText: 'Acepto el tratamiento facial.',
      })
      .expect(201);
    const booking = await http()
      .post(`${base}/bookings`)
      .set(auth(masterToken))
      .send({
        clientId: client.body.id,
        serviceId: service.body.id,
        staffId: professional.body.id,
        startAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);
    await http()
      .patch(`${base}/bookings/${booking.body.id}`)
      .set(auth(masterToken))
      .send({ status: 'COMPLETED' })
      .expect(409);
    await http()
      .patch(`${base}/bookings/${booking.body.id}`)
      .set(auth(masterToken))
      .send({ status: 'CANCELLED' })
      .expect(200);
    const replacement = await http()
      .post(`${base}/bookings`)
      .set(auth(masterToken))
      .send({
        clientId: client.body.id,
        serviceId: service.body.id,
        staffId: professional.body.id,
        startAt: booking.body.startAt,
      })
      .expect(201);
    await http()
      .patch(`${base}/bookings/${booking.body.id}`)
      .set(auth(masterToken))
      .send({ status: 'SCHEDULED' })
      .expect(409);
    await http()
      .patch(`${base}/bookings/${replacement.body.id}`)
      .set(auth(masterToken))
      .send({ status: 'CANCELLED' })
      .expect(200);
    await http()
      .patch(`${base}/bookings/${booking.body.id}`)
      .set(auth(masterToken))
      .send({ status: 'SCHEDULED' })
      .expect(200);
    await http()
      .delete(api(`/tenants/${tenantId}/users/${professional.body.id}`))
      .set(auth(masterToken))
      .expect(409);
    await http()
      .patch(api(`/tenants/${tenantId}/users/${professional.body.id}`))
      .set(auth(masterToken))
      .send({ role: 'ASISTENTE' })
      .expect(409);
    const session = await http()
      .post(`${base}/sessions`)
      .set(auth(masterToken))
      .send({
        clientId: client.body.id,
        serviceId: service.body.id,
        staffId: professional.body.id,
        bookingId: booking.body.id,
        notes: 'Primera sesión',
      })
      .expect(201);
    await http()
      .patch(`${base}/bookings/${booking.body.id}`)
      .set(auth(masterToken))
      .send({ status: 'CANCELLED' })
      .expect(409);
    await http()
      .post(`${base}/sessions/${session.body.id}/complete`)
      .set(auth(masterToken))
      .send({})
      .expect(409);
    await http()
      .patch(`${base}/services/${service.body.id}`)
      .set(auth(masterToken))
      .send({ consentText: 'Acepto el tratamiento facial actualizado.' })
      .expect(200);
    await http()
      .post(`${base}/sessions/${session.body.id}/consent`)
      .set(auth(masterToken))
      .send({ signerName: 'Lucía Mora', expectedConsentText: 'Acepto el tratamiento facial.' })
      .expect(409);
    const consent = await http()
      .post(`${base}/sessions/${session.body.id}/consent`)
      .set(auth(masterToken))
      .send({
        signerName: 'Lucía Mora',
        expectedConsentText: 'Acepto el tratamiento facial actualizado.',
      })
      .expect(201);
    expect(consent.body.bodySnapshot).toBe('Acepto el tratamiento facial actualizado.');
    await http()
      .post(`${base}/sessions/${session.body.id}/complete`)
      .set(auth(masterToken))
      .send({})
      .expect(201);
    const completedBookings = await http()
      .get(`${base}/bookings`)
      .set(auth(masterToken))
      .expect(200);
    expect(
      completedBookings.body.find((item: { id: string }) => item.id === booking.body.id).status,
    ).toBe('COMPLETED');
    await http()
      .delete(api(`/tenants/${tenantId}/users/${professional.body.id}`))
      .set(auth(masterToken))
      .expect(200);

    const noConsentService = await http()
      .post(`${base}/services`)
      .set(auth(masterToken))
      .send({ name: 'Revisión estética', durationMinutes: 30, price: 0 })
      .expect(201);
    const finishedWithoutConsent = await http()
      .post(`${base}/sessions`)
      .set(auth(masterToken))
      .send({
        clientId: client.body.id,
        serviceId: noConsentService.body.id,
        staffId: created.body.master.id,
      })
      .expect(201);
    await http()
      .post(`${base}/sessions/${finishedWithoutConsent.body.id}/complete`)
      .set(auth(masterToken))
      .send({})
      .expect(201);
    await http()
      .patch(`${base}/services/${noConsentService.body.id}`)
      .set(auth(masterToken))
      .send({ consentText: 'Acepto la revisión.' })
      .expect(200);
    await http()
      .post(`${base}/sessions/${finishedWithoutConsent.body.id}/consent`)
      .set(auth(masterToken))
      .send({ signerName: 'Lucía Mora', expectedConsentText: 'Acepto la revisión.' })
      .expect(409);

    const photo = await http()
      .post(`${base}/sessions/${session.body.id}/photos`)
      .set(auth(masterToken))
      .field('phase', 'BEFORE')
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), {
        filename: 'before.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    expect(photo.body.storageKey).toBeUndefined();
    const sessions = await http().get(`${base}/sessions`).set(auth(masterToken)).expect(200);
    expect(
      sessions.body.find((item: { id: string }) => item.id === session.body.id),
    ).not.toHaveProperty('photos');
    const roleUrl = api(`/platform/tenants/${tenantId}/roles/MASTER/permissions`);
    const role = await http().get(roleUrl).set(auth(adminToken)).expect(200);
    await http()
      .put(roleUrl)
      .set(auth(adminToken))
      .send({
        allowed: role.body.effective.filter(
          (permission: string) => permission !== 'aesthetics.photos.view',
        ),
      })
      .expect(200);
    await http()
      .get(`${base}/sessions/${session.body.id}/photos`)
      .set(auth(masterToken))
      .expect(403);
    await http()
      .get(`${base}/sessions/${session.body.id}/photos/${photo.body.id}/download`)
      .set(auth(masterToken))
      .expect(403);
    await http()
      .put(roleUrl)
      .set(auth(adminToken))
      .send({ allowed: role.body.effective })
      .expect(200);
    await http()
      .get(`${base}/sessions/${session.body.id}/photos/${photo.body.id}/download`)
      .set(auth(masterToken))
      .expect(200)
      .expect('Content-Type', /image\/jpeg/);
  });
});
