import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { UsersService } from './../src/users/users.service';
import { VALIDATION_PIPE_OPTIONS } from './../src/common/validation-options';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(120000);

/**
 * Server-side paging of GET patients | tasks | appointments against a real database: the response
 * without `page`/`limit` is the bare array it always was, and with them it is `{ data, meta }`
 * over the very same rows, with the tenant, role and soft-delete filters intact.
 */
describe('Paged lists (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tokens: Record<string, string> = {};
  let tenantId: string;
  let otherTenantId: string;
  let proId: string;
  let otherProId: string;
  let masterId: string;
  let anaId: string;

  const server = () => app.getHttpServer();
  const base = (tenant = tenantId) => `/api/v1/tenants/${tenant}`;
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const login = async (email: string) =>
    (
      await request(server())
        .post('/api/v1/auth/login')
        .send({ email, password: TEST_PASSWORD })
        .expect(200)
    ).body.accessToken as string;
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

  /** Reads every page of a list and checks the meta on the way. */
  async function walk(url: string, who: string, limit: number) {
    const rows: { id: string }[] = [];
    let total = -1;
    for (let page = 1; page <= 50; page += 1) {
      const sep = url.includes('?') ? '&' : '?';
      const res = await request(server())
        .get(`${url}${sep}page=${page}&limit=${limit}`)
        .set(as(who))
        .expect(200);
      expect(Array.isArray(res.body)).toBe(false);
      const { data, meta } = res.body;
      if (total === -1) total = meta.total;
      expect(meta).toEqual({
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
      expect(data.length).toBeLessThanOrEqual(limit);
      rows.push(...data);
      if (page >= meta.totalPages) break;
    }
    return { rows, total };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    prisma = app.get(PrismaService);
    const users = app.get(UsersService);
    await prisma.cleanDatabase();

    const tenants = app.get(PlatformTenantsService);
    tenantId = (await createTestTenant({ tenants, prisma }, 1)).id;
    otherTenantId = (await createTestTenant({ tenants, prisma }, 2)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId },
      data: { seatsPsychologistsMax: 5, maxActivePatients: 500 },
    });
    const specialtyId = (
      await prisma.specialty.findUniqueOrThrow({ where: { code: 'PSYCHOLOGY' } })
    ).id;
    const makePro = async (email: string, lastName: string) =>
      (
        await users.create(
          {
            tenantId,
            email,
            password: TEST_PASSWORD,
            firstName: 'Pro',
            lastName,
            role: 'PROFESIONAL',
            professionalProfile: { specialtyId },
          },
          'fixture-actor',
        )
      ).id;
    proId = await makePro('pro1@paged.test', 'Uno');
    otherProId = await makePro('pro2@paged.test', 'Dos');
    await users.create(
      {
        tenantId,
        email: 'assistant@paged.test',
        password: TEST_PASSWORD,
        firstName: 'Asis',
        lastName: 'Tente',
        role: 'ASISTENTE',
      },
      'fixture-actor',
    );
    masterId = (await prisma.user.findFirstOrThrow({ where: { tenantId, role: 'MASTER' } })).id;

    tokens.master = await login('admin+1@tenant.test');
    tokens.otherMaster = await login('admin+2@tenant.test');
    tokens.pro = await login('pro1@paged.test');
    tokens.assistant = await login('assistant@paged.test');

    // 25 live patients with the SAME last name (ties), 3 with other last names, one inactive but
    // not deleted, one deleted, and 4 in another tenant.
    const patient = (n: string, extra: Record<string, unknown> = {}, tenant = tenantId) => ({
      tenantId: tenant,
      firstName: `Nombre${n}`,
      lastName: 'Zeta',
      email: `paciente${n}@paged.test`,
      ...extra,
    });
    await prisma.patient.createMany({
      data: [
        ...Array.from({ length: 25 }, (_, i) => patient(String(i).padStart(2, '0'))),
        patient('A1', { lastName: 'Alfa', phone: '0991112223' }),
        patient('B1', {
          lastName: 'Beta',
          identificationType: 'CEDULA',
          identificationNumber: 'ABC9876',
        }),
        patient('C1', { lastName: 'Gamma' }),
        patient('INACT', { lastName: 'Inactivo', isActive: false }),
        patient('DEL', { lastName: 'Borrado', isActive: false, deletedAt: new Date() }),
        ...Array.from({ length: 4 }, (_, i) =>
          patient(`O${i}`, { lastName: 'Zeta' }, otherTenantId),
        ),
      ],
    });
    anaId = (await prisma.patient.findFirstOrThrow({ where: { tenantId, firstName: 'NombreA1' } }))
      .id;

    // Tasks: 23 for the tenant; the professional created/is assigned to 9 of them. Many share the
    // same due date and priority so only the id keeps pages apart.
    const patients = await prisma.patient.findMany({
      where: { tenantId, deletedAt: null },
      take: 3,
    });
    const due = new Date('2027-01-15T12:00:00.000Z');
    const task = (i: number, extra: Record<string, unknown> = {}) => ({
      tenantId,
      patientId: patients[i % 3].id,
      title: `Tarea ${i}`,
      createdById: masterId,
      dueDate: i % 5 === 0 ? null : due,
      priority: (['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const)[i % 4],
      status: (['PENDING', 'IN_PROGRESS', 'COMPLETED'] as const)[i % 3],
      ...extra,
    });
    await prisma.task.createMany({
      data: [
        ...Array.from({ length: 14 }, (_, i) => task(i)),
        ...Array.from({ length: 5 }, (_, i) => task(20 + i, { assignedToId: proId })),
        ...Array.from({ length: 4 }, (_, i) => task(30 + i, { createdById: proId })),
        task(40, { assignedToId: otherProId }),
      ],
    });
    await prisma.task.create({
      data: {
        tenantId: otherTenantId,
        patientId: (await prisma.patient.findFirstOrThrow({ where: { tenantId: otherTenantId } }))
          .id,
        title: 'Tarea ajena',
        createdById: (await prisma.user.findFirstOrThrow({ where: { tenantId: otherTenantId } }))
          .id,
      },
    });

    // Appointments: 12 of professional 1 and 7 of professional 2, several at the same time.
    const start = (i: number) => new Date(`2027-02-${10 + (i % 3)}T1${i % 2}:00:00.000Z`);
    const appointment = (i: number, professionalId: string) => ({
      tenantId,
      patientId: anaId,
      professionalId,
      psychologistId: professionalId,
      specialtyId,
      startTime: start(i),
      endTime: new Date(start(i).getTime() + 3600000),
      duration: 60,
    });
    await prisma.appointment.createMany({
      data: [
        ...Array.from({ length: 12 }, (_, i) => appointment(i, proId)),
        ...Array.from({ length: 7 }, (_, i) => appointment(i, otherProId)),
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('patients', () => {
    it('without page or limit is the bare array of live, active patients of the tenant', async () => {
      const res = await request(server()).get(`${base()}/patients`).set(as('master')).expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(28);
      expect(res.body.every((p: { tenantId: string }) => p.tenantId === tenantId)).toBe(true);
      const lastNames = res.body.map((p: { lastName: string }) => p.lastName);
      expect(lastNames).toEqual([...lastNames].sort((a, b) => a.localeCompare(b)));
    });

    it('still accepts the isActive the web has always sent', async () => {
      const res = await request(server())
        .get(`${base()}/patients?isActive=true&search=`)
        .set(as('master'))
        .expect(200);
      expect(res.body).toHaveLength(28);
    });

    it('pages through the same rows with no duplicates and a total that matches', async () => {
      const all = await request(server()).get(`${base()}/patients`).set(as('master')).expect(200);
      const { rows, total } = await walk(`${base()}/patients`, 'master', 10);

      expect(total).toBe(28);
      expect(rows).toHaveLength(28);
      expect(new Set(ids(rows)).size).toBe(28);
      expect(new Set(ids(rows))).toEqual(new Set(ids(all.body)));
      // Same order on every request: last name, then id.
      const again = await walk(`${base()}/patients`, 'master', 10);
      expect(ids(again.rows)).toEqual(ids(rows));
      const zetas = rows.filter((p: any) => p.lastName === 'Zeta');
      expect(ids(zetas)).toEqual([...ids(zetas)].sort());
    });

    it('pages a search with the same filter in the page and in the total', async () => {
      const res = await request(server())
        .get(`${base()}/patients?search=PACIENTE0&page=2&limit=4`)
        .set(as('master'))
        .expect(200);
      // paciente00..paciente09 match
      expect(res.body.meta).toEqual({ page: 2, limit: 4, total: 10, totalPages: 3 });
      expect(res.body.data).toHaveLength(4);

      const byPhone = await request(server())
        .get(`${base()}/patients?search=1112&limit=5`)
        .set(as('master'))
        .expect(200);
      expect(byPhone.body.meta.total).toBe(1);
      const byId = await request(server())
        .get(`${base()}/patients?search=abc-9876&page=1`)
        .set(as('master'))
        .expect(200);
      expect(byId.body.meta.total).toBe(1);
    });

    it('answers an empty page beyond the last one without failing', async () => {
      const res = await request(server())
        .get(`${base()}/patients?page=99&limit=10`)
        .set(as('master'))
        .expect(200);
      expect(res.body).toEqual({
        data: [],
        meta: { page: 99, limit: 10, total: 28, totalPages: 3 },
      });
    });

    it('filters by status on the server and never lists a deleted patient', async () => {
      const inactive = await request(server())
        .get(`${base()}/patients?status=inactive&page=1`)
        .set(as('master'))
        .expect(200);
      expect(inactive.body.data.map((p: { firstName: string }) => p.firstName)).toEqual([
        'NombreINACT',
      ]);

      const all = await request(server())
        .get(`${base()}/patients?status=all&page=1&limit=100`)
        .set(as('master'))
        .expect(200);
      expect(all.body.meta.total).toBe(29);
      expect(all.body.data.map((p: { firstName: string }) => p.firstName)).not.toContain(
        'NombreDEL',
      );

      const active = await request(server())
        .get(`${base()}/patients?status=active`)
        .set(as('master'))
        .expect(200);
      expect(active.body).toHaveLength(28);
    });

    // Decision of the project owner: every role that lists patients may list the archived ones.
    it.each(['master', 'pro', 'assistant'])(
      'lets %s list an archived patient with status, never by default, and never a deleted one',
      async (who) => {
        const names = (body: { firstName: string }[]) => body.map((p) => p.firstName);
        const get = (query: string) =>
          request(server()).get(`${base()}/patients${query}`).set(as(who)).expect(200);

        expect(names((await get('')).body)).not.toContain('NombreINACT');
        expect(names((await get('?status=active')).body)).not.toContain('NombreINACT');
        expect(names((await get('?page=1&limit=100')).body.data)).not.toContain('NombreINACT');

        expect(names((await get('?status=inactive')).body)).toEqual(['NombreINACT']);
        expect(names((await get('?status=inactive&page=1')).body.data)).toEqual(['NombreINACT']);
        const all = await get('?status=all&page=1&limit=100');
        expect(all.body.meta.total).toBe(29);
        expect(names(all.body.data)).toContain('NombreINACT');

        for (const status of ['active', 'inactive', 'all']) {
          const rows = (await get(`?status=${status}&page=1&limit=100`)).body.data;
          expect(names(rows)).not.toContain('NombreDEL');
        }
        expect(names((await get('?status=all&search=DEL')).body)).toEqual([]);
      },
    );

    it('keeps the contract of a request without parameters: unknown or empty ones are ignored', async () => {
      for (const query of [
        '?_=1700000000',
        '?foo=bar',
        '?page=',
        '?limit=',
        '?page=&limit=&status=',
      ]) {
        const res = await request(server())
          .get(`${base()}/patients${query}`)
          .set(as('master'))
          .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(28);
      }
      const long = await request(server())
        .get(`${base()}/patients?search=${'z'.repeat(300)}`)
        .set(as('master'))
        .expect(200);
      expect(long.body).toEqual([]);
      await request(server()).get(`${base()}/patients?page=0`).set(as('master')).expect(400);
    });

    it('does not match every patient with an identification when the search is only hyphens', async () => {
      const res = await request(server())
        .get(`${base()}/patients?search=-`)
        .set(as('master'))
        .expect(200);
      expect(res.body).toEqual([]);
    });

    it('takes % and _ in a search literally', async () => {
      for (const term of ['%', '_', '%%', 'N_mbre']) {
        const res = await request(server())
          .get(`${base()}/patients?search=${encodeURIComponent(term)}`)
          .set(as('master'))
          .expect(200);
        expect(res.body).toEqual([]);
      }

      // ...and still finds a name that really contains them.
      const lastName = 'Wild_100%\\Card';
      await prisma.patient.createMany({
        data: [
          { tenantId, firstName: 'Literal', lastName },
          { tenantId, firstName: 'Decoy', lastName: 'WildX100ZZCard' },
        ],
      });
      try {
        for (const term of ['Wild_100%\\Card', 'ild_1', '0%\\C', 'LD_100']) {
          const res = await request(server())
            .get(`${base()}/patients?search=${encodeURIComponent(term)}`)
            .set(as('master'))
            .expect(200);
          expect(res.body.map((p: { firstName: string }) => p.firstName)).toEqual(['Literal']);
        }
      } finally {
        await prisma.patient.deleteMany({
          where: { tenantId, firstName: { in: ['Literal', 'Decoy'] } },
        });
      }
    });

    it('takes % and _ literally in the phone and identification branches too (LIKE without ILIKE)', async () => {
      const search = async (term: string) =>
        (
          await request(server())
            .get(`${base()}/patients?search=${encodeURIComponent(term)}`)
            .set(as('master'))
            .expect(200)
        ).body.map((p: { firstName: string }) => p.firstName);

      // Wildcard stand-ins for characters of the real phone 0991112223 and identification ABC9876.
      expect(await search('099_112223')).toEqual([]);
      expect(await search('0991%2223')).toEqual([]);
      expect(await search('ABC9_76')).toEqual([]);
      expect(await search('ABC%76')).toEqual([]);
      // The real values are still found, by their phone and by their identification.
      expect(await search('0991112223')).toEqual(['NombreA1']);
      expect(await search('abc9876')).toEqual(['NombreB1']);

      // ...and a phone / identification that really contains the characters is found by them.
      await prisma.patient.createMany({
        data: [
          {
            tenantId,
            firstName: 'LiteralPhone',
            lastName: 'Comodin',
            phone: '55_5%99',
            identificationType: 'OTHER',
            identificationNumber: 'ZZ_9%9',
          },
          {
            tenantId,
            firstName: 'DecoyPhone',
            lastName: 'Comodin',
            phone: '5575559999',
            identificationType: 'OTHER',
            identificationNumber: 'ZZX9Y9',
          },
        ],
      });
      try {
        expect(await search('55_5%99')).toEqual(['LiteralPhone']);
        expect(await search('5_5%')).toEqual(['LiteralPhone']);
        expect(await search('ZZ_9%9')).toEqual(['LiteralPhone']);
        expect(await search('Z_9%')).toEqual(['LiteralPhone']);
      } finally {
        await prisma.patient.deleteMany({
          where: { tenantId, firstName: { in: ['LiteralPhone', 'DecoyPhone'] } },
        });
      }
    });

    it('keeps tenants apart', async () => {
      const res = await request(server())
        .get(`${base(otherTenantId)}/patients?page=1&limit=100`)
        .set(as('otherMaster'))
        .expect(200);
      expect(res.body.meta.total).toBe(4);
      await request(server())
        .get(`${base(otherTenantId)}/patients?page=1`)
        .set(as('master'))
        .expect(403);
    });

    it('answers 403, not data, for another tenant on every paged list and on the summary', async () => {
      for (const path of [
        'patients?page=1',
        'tasks?page=1',
        'tasks/summary',
        'appointments?page=1',
      ]) {
        await request(server())
          .get(`${base(otherTenantId)}/${path}`)
          .set(as('master'))
          .expect(403);
        await request(server())
          .get(`${base(tenantId)}/${path}`)
          .set(as('otherMaster'))
          .expect(403);
      }
    });

    it.each(['master', 'pro', 'assistant'])('lets %s page the list', async (who) => {
      const res = await request(server())
        .get(`${base()}/patients?page=1&limit=5`)
        .set(as(who))
        .expect(200);
      expect(res.body.meta.total).toBe(28);
    });

    it.each(['page=0', 'limit=0', 'limit=1000', 'page=abc', 'limit=1.5', 'status=archived'])(
      'rejects %s with 400',
      async (query) => {
        await request(server()).get(`${base()}/patients?${query}`).set(as('master')).expect(400);
      },
    );
  });

  describe('tasks', () => {
    it('without page or limit is the bare array; a professional sees only their own', async () => {
      const master = await request(server()).get(`${base()}/tasks`).set(as('master')).expect(200);
      expect(Array.isArray(master.body)).toBe(true);
      expect(master.body).toHaveLength(24);
      expect(master.body.every((t: { tenantId: string }) => t.tenantId === tenantId)).toBe(true);

      const pro = await request(server()).get(`${base()}/tasks`).set(as('pro')).expect(200);
      expect(Array.isArray(pro.body)).toBe(true);
      expect(pro.body).toHaveLength(9);
      expect(
        pro.body.every(
          (t: { createdById: string; assignedToId: string }) =>
            t.createdById === proId || t.assignedToId === proId,
        ),
      ).toBe(true);
    });

    it('pages every task once, in the order of the unpaged list', async () => {
      const all = await request(server()).get(`${base()}/tasks`).set(as('master')).expect(200);
      const { rows, total } = await walk(`${base()}/tasks`, 'master', 7);

      expect(total).toBe(24);
      expect(new Set(ids(rows)).size).toBe(24);
      expect(new Set(ids(rows))).toEqual(new Set(ids(all.body)));
      // Pages run through the groups: PENDING, IN_PROGRESS, COMPLETED, CANCELLED, each by due date
      // (a task without one last).
      const rank = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
      for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1] as any, rows[i] as any];
        expect(rank.indexOf(a.status)).toBeLessThanOrEqual(rank.indexOf(b.status));
        if (a.status === b.status && a.dueDate && b.dueDate) {
          expect(a.dueDate <= b.dueDate).toBe(true);
        }
        if (a.status === b.status && !a.dueDate) expect(b.dueDate).toBeNull();
      }
    });

    it("pages a professional's tasks without leaking anyone else's", async () => {
      const { rows, total } = await walk(`${base()}/tasks`, 'pro', 4);
      expect(total).toBe(9);
      expect(rows).toHaveLength(9);
      expect(new Set(ids(rows)).size).toBe(9);
      expect(rows.every((t: any) => t.createdById === proId || t.assignedToId === proId)).toBe(
        true,
      );

      // A filter cannot widen the limit: asking for the other professional's tasks yields none.
      const other = await request(server())
        .get(`${base()}/tasks?assignedToId=${otherProId}&page=1`)
        .set(as('pro'))
        .expect(200);
      expect(other.body).toEqual({
        data: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it('applies the filters to the page and to the total', async () => {
      const res = await request(server())
        .get(`${base()}/tasks?status=PENDING&priority=LOW&page=1&limit=50`)
        .set(as('master'))
        .expect(200);
      const unpaged = await request(server())
        .get(`${base()}/tasks?status=PENDING&priority=LOW`)
        .set(as('master'))
        .expect(200);
      expect(res.body.meta.total).toBe(unpaged.body.length);
      expect(res.body.data.every((t: any) => t.status === 'PENDING' && t.priority === 'LOW')).toBe(
        true,
      );
      expect(ids(res.body.data).sort()).toEqual(ids(unpaged.body).sort());
    });

    it('searches title and patient name on the server, page and total alike', async () => {
      const byTitle = await request(server())
        .get(`${base()}/tasks?search=TAREA%203&page=1&limit=50`)
        .set(as('master'))
        .expect(200);
      // "Tarea 3", "Tarea 30".."Tarea 33" (case-insensitive)
      expect(byTitle.body.meta.total).toBe(5);
      expect(byTitle.body.data.map((t: { title: string }) => t.title).sort()).toEqual([
        'Tarea 3',
        'Tarea 30',
        'Tarea 31',
        'Tarea 32',
        'Tarea 33',
      ]);

      const byPatient = await request(server())
        .get(`${base()}/tasks?search=nombre&page=1&limit=100`)
        .set(as('master'))
        .expect(200);
      expect(byPatient.body.meta.total).toBe(24);

      // The ownership limit still applies to a search: tasks 30-33 are the professional's own.
      const own = await request(server())
        .get(`${base()}/tasks?search=Tarea%203&page=1`)
        .set(as('pro'))
        .expect(200);
      expect(own.body.meta.total).toBe(4);
    });

    it('takes % and _ in a search literally, in title, description and patient name', async () => {
      const search = async (term: string, who = 'master') =>
        (
          await request(server())
            .get(`${base()}/tasks?search=${encodeURIComponent(term)}&page=1&limit=50`)
            .set(as(who))
            .expect(200)
        ).body;

      // Without escaping, a lone wildcard would match every task of the clinic.
      for (const term of ['%', '_', '%%', 'T_rea', '\\']) {
        const body = await search(term);
        expect(body.data).toEqual([]);
        expect(body.meta.total).toBe(0);
      }

      const wildPatient = await prisma.patient.create({
        data: { tenantId, firstName: 'Fran_k', lastName: 'Cien%Por\\Ciento' },
      });
      const decoyPatient = await prisma.patient.create({
        data: { tenantId, firstName: 'FranXk', lastName: 'CienXPorXCiento' },
      });
      const make = (title: string, description: string | null, patientId: string) => ({
        tenantId,
        patientId,
        title,
        description,
        createdById: masterId,
        assignedToId: proId,
      });
      const wildTasks = [
        make('Meta 100%_ok', null, anaId),
        make('Meta 100XXok', null, anaId),
        make('Con descripcion', 'avance 50%_final', anaId),
        make('Con descripcion decoy', 'avance 50XXfinal', anaId),
        make('Por paciente nombre', null, wildPatient.id),
        make('Por paciente apellido', null, wildPatient.id),
        make('Decoy paciente', null, decoyPatient.id),
      ];
      await prisma.task.createMany({ data: wildTasks });
      try {
        const titles = async (term: string, who = 'master') =>
          (await search(term, who)).data.map((t: { title: string }) => t.title).sort();

        // title
        expect(await titles('100%_ok')).toEqual(['Meta 100%_ok']);
        expect(await titles('t_ 100')).toEqual([]);
        // description
        expect(await titles('50%_final')).toEqual(['Con descripcion']);
        // patient first name and last name: both tasks of the wild patient, none of the decoy
        expect(await titles('Fran_k')).toEqual(['Por paciente apellido', 'Por paciente nombre']);
        expect(await titles('Cien%Por\\Ciento')).toEqual([
          'Por paciente apellido',
          'Por paciente nombre',
        ]);
        // the total of the page counts the same rows, and the professional's limit still applies
        expect((await search('100%_ok')).meta.total).toBe(1);
        expect(await titles('100%_ok', 'pro')).toEqual(['Meta 100%_ok']);
      } finally {
        await prisma.task.deleteMany({
          where: { tenantId, title: { in: wildTasks.map((task) => task.title) } },
        });
        await prisma.patient.deleteMany({
          where: { id: { in: [wildPatient.id, decoyPatient.id] } },
        });
      }
    });

    it('counts the states for the task page headings, under the same visibility', async () => {
      const master = await request(server())
        .get(`${base()}/tasks/summary`)
        .set(as('master'))
        .expect(200);
      const all = await request(server()).get(`${base()}/tasks`).set(as('master')).expect(200);
      const count = (status: string[]) =>
        all.body.filter((t: { status: string }) => status.includes(t.status)).length;
      expect(master.body).toEqual({
        pending: count(['PENDING', 'IN_PROGRESS']),
        overdue: 0, // every due date is in 2027
        completed: count(['COMPLETED']),
        cancelled: 0,
      });

      const pro = await request(server()).get(`${base()}/tasks/summary`).set(as('pro')).expect(200);
      expect(pro.body.pending + pro.body.completed + pro.body.cancelled).toBe(9);

      const filtered = await request(server())
        .get(`${base()}/tasks/summary?priority=LOW`)
        .set(as('master'))
        .expect(200);
      const lowCount = all.body.filter((t: { priority: string }) => t.priority === 'LOW').length;
      expect(filtered.body.pending + filtered.body.completed + filtered.body.cancelled).toBe(
        lowCount,
      );
    });

    it('counts a task past its due date as overdue only while it is open', async () => {
      const patient = await prisma.patient.findFirstOrThrow({ where: { tenantId } });
      const past = new Date('2020-01-01T00:00:00.000Z');
      await prisma.task.createMany({
        data: [
          { status: 'PENDING' as const },
          { status: 'IN_PROGRESS' as const },
          { status: 'COMPLETED' as const },
          { status: 'CANCELLED' as const },
        ].map((extra, i) => ({
          tenantId,
          patientId: patient.id,
          title: `Vencida ${i}`,
          createdById: masterId,
          dueDate: past,
          ...extra,
        })),
      });
      try {
        const res = await request(server())
          .get(`${base()}/tasks/summary?search=Vencida`)
          .set(as('master'))
          .expect(200);
        expect(res.body).toEqual({ pending: 2, overdue: 2, completed: 1, cancelled: 1 });
      } finally {
        await prisma.task.deleteMany({ where: { tenantId, title: { startsWith: 'Vencida' } } });
      }
    });

    it('keeps the contract of a request without parameters: unknown or empty ones are ignored', async () => {
      for (const query of [
        '?_=1700000000',
        '?foo=bar',
        '?page=',
        '?limit=',
        '?status=&priority=',
      ]) {
        const res = await request(server())
          .get(`${base()}/tasks${query}`)
          .set(as('master'))
          .expect(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(24);
      }
      await request(server())
        .get(`${base()}/tasks?search=${'z'.repeat(300)}`)
        .set(as('master'))
        .expect(200);
      await request(server()).get(`${base()}/tasks?page=0`).set(as('master')).expect(400);
    });

    it('lets the assistant count the clinic tasks, like the master', async () => {
      const master = await request(server())
        .get(`${base()}/tasks/summary`)
        .set(as('master'))
        .expect(200);
      const assistant = await request(server())
        .get(`${base()}/tasks/summary`)
        .set(as('assistant'))
        .expect(200);
      expect(assistant.body).toEqual(master.body);
      await request(server()).get(`${base()}/tasks/summary?_=1`).set(as('assistant')).expect(200);
    });

    it.each(['page=0', 'limit=101', 'limit=abc', 'status=DONE', 'priority=NOW'])(
      'rejects %s with 400',
      async (query) => {
        await request(server()).get(`${base()}/tasks?${query}`).set(as('master')).expect(400);
      },
    );
  });

  describe('appointments', () => {
    it('without page or limit is the bare array; a professional sees only their calendar', async () => {
      const master = await request(server())
        .get(`${base()}/appointments`)
        .set(as('master'))
        .expect(200);
      expect(Array.isArray(master.body)).toBe(true);
      expect(master.body).toHaveLength(19);
      const times = master.body.map((a: { startTime: string }) => a.startTime);
      expect(times).toEqual([...times].sort());

      const pro = await request(server()).get(`${base()}/appointments`).set(as('pro')).expect(200);
      expect(pro.body).toHaveLength(12);
      expect(pro.body.every((a: any) => a.professionalId === proId)).toBe(true);
    });

    it('pages every appointment once even when many start at the same time', async () => {
      const all = await request(server())
        .get(`${base()}/appointments`)
        .set(as('master'))
        .expect(200);
      const { rows, total } = await walk(`${base()}/appointments`, 'master', 5);
      expect(total).toBe(19);
      expect(new Set(ids(rows)).size).toBe(19);
      expect(new Set(ids(rows))).toEqual(new Set(ids(all.body)));
      const times = rows.map((a: any) => a.startTime);
      expect(times).toEqual([...times].sort());
    });

    it("keeps a professional's page inside their own calendar", async () => {
      const { rows, total } = await walk(`${base()}/appointments`, 'pro', 5);
      expect(total).toBe(12);
      expect(new Set(ids(rows)).size).toBe(12);
      expect(rows.every((a: any) => a.professionalId === proId)).toBe(true);

      const asked = await request(server())
        .get(`${base()}/appointments?professionalId=${otherProId}&page=1`)
        .set(as('pro'))
        .expect(200);
      expect(asked.body.meta.total).toBe(0);
    });

    it('still asks an assistant for a professional, paged or not', async () => {
      await request(server()).get(`${base()}/appointments`).set(as('assistant')).expect(400);
      await request(server()).get(`${base()}/appointments?page=1`).set(as('assistant')).expect(400);
      const res = await request(server())
        .get(`${base()}/appointments?professionalId=${otherProId}&page=1&limit=3`)
        .set(as('assistant'))
        .expect(200);
      expect(res.body.meta).toEqual({ page: 1, limit: 3, total: 7, totalPages: 3 });
    });

    it('filters by range and status in the page and in the total', async () => {
      const url = `${base()}/appointments?from=2027-02-11T00:00:00.000Z&to=2027-02-11T23:59:59.000Z`;
      const unpaged = await request(server()).get(url).set(as('master')).expect(200);
      const paged = await request(server())
        .get(`${url}&page=1&limit=100`)
        .set(as('master'))
        .expect(200);
      expect(paged.body.meta.total).toBe(unpaged.body.length);
      expect(unpaged.body.length).toBeGreaterThan(0);
      expect(unpaged.body.length).toBeLessThan(19);
    });

    it.each(['page=0', 'limit=101', 'page=abc'])('rejects %s with 400', async (query) => {
      await request(server()).get(`${base()}/appointments?${query}`).set(as('master')).expect(400);
    });
  });

  describe('task page order: open tasks first', () => {
    const url = () => `${base(otherTenantId)}/tasks`;

    beforeAll(async () => {
      const masterId2 = (
        await prisma.user.findFirstOrThrow({ where: { tenantId: otherTenantId, role: 'MASTER' } })
      ).id;
      const patientId = (
        await prisma.patient.findFirstOrThrow({ where: { tenantId: otherTenantId } })
      ).id;
      const row = (
        title: string,
        status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
        dueDate: Date | null,
      ) => ({ tenantId: otherTenantId, patientId, title, status, dueDate, createdById: masterId2 });
      await prisma.task.deleteMany({ where: { tenantId: otherTenantId } });
      await prisma.task.createMany({
        data: [
          // 25 old completed tasks (early due dates) that used to bury the open ones
          ...Array.from({ length: 25 }, (_, i) =>
            row(
              `Hecha ${String(i).padStart(2, '0')}`,
              'COMPLETED',
              new Date(Date.UTC(2020, 0, 1 + i)),
            ),
          ),
          row('Abierta A', 'PENDING', new Date('2030-03-01T00:00:00.000Z')),
          row('Abierta B', 'PENDING', new Date('2030-01-01T00:00:00.000Z')),
          row('En curso', 'IN_PROGRESS', new Date('2030-02-01T00:00:00.000Z')),
          row('Cancelada 1', 'CANCELLED', new Date('2019-01-01T00:00:00.000Z')),
          row('Cancelada 2', 'CANCELLED', null),
        ],
      });
    });

    it('starts page 1 with the open tasks even though 25 completed ones are older', async () => {
      const res = await request(server())
        .get(`${url()}?page=1&limit=10`)
        .set(as('otherMaster'))
        .expect(200);

      expect(res.body.meta).toEqual({ page: 1, limit: 10, total: 30, totalPages: 3 });
      const titles = res.body.data.map((t: { title: string }) => t.title);
      // PENDING by due date, then IN_PROGRESS, then the completed ones from the oldest.
      expect(titles.slice(0, 3)).toEqual(['Abierta B', 'Abierta A', 'En curso']);
      expect(titles.slice(3)).toEqual(
        Array.from({ length: 7 }, (_, i) => `Hecha ${String(i).padStart(2, '0')}`),
      );
    });

    it('ends with the cancelled tasks and repeats none across the pages', async () => {
      const { rows, total } = await walk(url(), 'otherMaster', 10);
      expect(total).toBe(30);
      expect(new Set(ids(rows)).size).toBe(30);
      const statuses = rows.map((t: any) => t.status);
      expect(statuses.slice(0, 3)).toEqual(['PENDING', 'PENDING', 'IN_PROGRESS']);
      expect(statuses.slice(-2)).toEqual(['CANCELLED', 'CANCELLED']);
    });

    it('keeps the order the unpaged list always had: by due date, no status grouping', async () => {
      const res = await request(server()).get(url()).set(as('otherMaster')).expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      const titles = res.body.map((t: { title: string }) => t.title);
      expect(titles[0]).toBe('Cancelada 1'); // 2019
      expect(titles[1]).toBe('Hecha 00'); // 2020
      expect(titles.slice(-4, -1)).toEqual(['Abierta B', 'En curso', 'Abierta A']); // 2030
      expect(titles[titles.length - 1]).toBe('Cancelada 2'); // no due date: last
    });

    it('keeps the open-first order inside a status filter and a search', async () => {
      const filtered = await request(server())
        .get(`${url()}?status=COMPLETED&page=2&limit=10`)
        .set(as('otherMaster'))
        .expect(200);
      expect(filtered.body.meta.total).toBe(25);
      expect(filtered.body.data[0].title).toBe('Hecha 10');
      const searched = await request(server())
        .get(`${url()}?search=abierta&page=1`)
        .set(as('otherMaster'))
        .expect(200);
      expect(searched.body.data.map((t: { title: string }) => t.title)).toEqual([
        'Abierta B',
        'Abierta A',
      ]);
    });
  });
});
