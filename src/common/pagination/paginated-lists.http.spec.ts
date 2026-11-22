import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppointmentsController } from '../../appointments/appointments.controller';
import { AppointmentsService } from '../../appointments/appointments.service';
import { PatientsController } from '../../patients/patients.controller';
import { PatientsService } from '../../patients/patients.service';
import { RlsContextService } from '../../prisma/rls-context.service';
import { TasksController } from '../../tasks/tasks.controller';
import { TasksService } from '../../tasks/tasks.service';
import { RolesGuard } from '../guards/roles.guard';
import { TenantGuard } from '../guards/tenant.guard';
import { PermissionChecker } from '../permissions/permission-checker.service';
import { VALIDATION_PIPE_OPTIONS } from '../validation-options';

/**
 * Query validation of the three list endpoints, through the same ValidationPipe options the API
 * runs with (whitelist, forbidNonWhitelisted, implicit conversion).
 */
describe('paged list endpoints: query string', () => {
  let app: INestApplication;
  const patients = { findAll: jest.fn() };
  const tasks = { findAll: jest.fn(), summary: jest.fn(), findOne: jest.fn() };
  const appointments = { findAll: jest.fn() };
  const actor = {
    userId: 'actor-1',
    tenantId: 'tenant-1',
    role: 'MASTER',
    email: 'a@example.test',
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PatientsController, TasksController, AppointmentsController],
      providers: [
        { provide: PatientsService, useValue: patients },
        { provide: TasksService, useValue: tasks },
        { provide: AppointmentsService, useValue: appointments },
        { provide: PermissionChecker, useValue: { assertAllowed: jest.fn() } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = { ...actor, role: req.header('x-test-role') || 'MASTER' };
      next();
    });
    app.useGlobalGuards(
      new TenantGuard(new Reflector(), new RlsContextService()),
      new RolesGuard(new Reflector()),
    );
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
  });

  afterAll(async () => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    patients.findAll.mockResolvedValue([]);
    tasks.findAll.mockResolvedValue([]);
    appointments.findAll.mockResolvedValue([]);
  });

  const get = (path: string) => request(app.getHttpServer()).get(`/tenants/tenant-1/${path}`);
  const endpoints = ['patients', 'tasks', 'appointments'] as const;
  const services = { patients, tasks, appointments };

  describe.each(endpoints)('GET %s', (endpoint) => {
    it.each(['page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=1000001', 'page=1&page=2'])(
      'rejects %s with 400',
      async (query) => {
        await get(`${endpoint}?${query}`).expect(400);
        expect(services[endpoint].findAll).not.toHaveBeenCalled();
      },
    );

    it.each(['limit=0', 'limit=101', 'limit=1000', 'limit=-5', 'limit=abc', 'limit=2.5'])(
      'rejects %s with 400',
      async (query) => {
        await get(`${endpoint}?${query}`).expect(400);
        expect(services[endpoint].findAll).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['page=1&limit=1', 1, 1],
      ['page=7&limit=100', 7, 100],
      ['page=2', 2, undefined],
      ['limit=50', undefined, 50],
    ])('accepts %s and forwards numbers', async (query, page, limit) => {
      await get(`${endpoint}?${query}`).expect(200);
      const call = services[endpoint].findAll.mock.calls[0];
      const forwarded = endpoint === 'patients' ? call[2] : call[1];
      expect(forwarded).toMatchObject({ page, limit });
    });

    it('forwards no page and no limit when the request has none', async () => {
      await get(endpoint).expect(200);
      const call = services[endpoint].findAll.mock.calls[0];
      const forwarded = endpoint === 'patients' ? call[2] : call[1];
      expect(forwarded.page).toBeUndefined();
      expect(forwarded.limit).toBeUndefined();
    });
  });

  // The endpoints read their parameters loosely, as they did before paging existed: the global
  // ValidationPipe does not check what is not a DTO, so nothing unknown or empty may turn into a 400.
  describe.each(['patients', 'tasks'] as const)(
    'GET %s: contract without parameters',
    (endpoint) => {
      const forwarded = () => {
        const call = services[endpoint].findAll.mock.calls[0];
        return endpoint === 'patients' ? call[2] : call[1];
      };

      it.each(['_=1700000000', 'foo=bar', 'isActive=true&x=1', 'page.x=1'])(
        'ignores the unknown parameter in ?%s and answers the array',
        async (query) => {
          const res = await get(`${endpoint}?${query}`).expect(200);
          expect(res.body).toEqual([]);
          expect(forwarded().page).toBeUndefined();
          expect(forwarded().limit).toBeUndefined();
        },
      );

      it.each(['page=', 'limit=', 'page=&limit='])(
        'treats an empty ?%s as not sent: the unpaged list',
        async (query) => {
          await get(`${endpoint}?${query}`).expect(200);
          expect(forwarded().page).toBeUndefined();
          expect(forwarded().limit).toBeUndefined();
        },
      );

      it('still rejects a page or a limit that has a value and is wrong', async () => {
        await get(`${endpoint}?page=0`).expect(400);
        await get(`${endpoint}?limit=1000`).expect(400);
        await get(`${endpoint}?page=abc`).expect(400);
        expect(services[endpoint].findAll).not.toHaveBeenCalled();
      });

      it('a valid page next to unknown and empty parameters still pages', async () => {
        await get(`${endpoint}?page=2&_=1&limit=`).expect(200);
        expect(forwarded()).toMatchObject({ page: 2 });
        expect(forwarded().limit).toBeUndefined();
      });
    },
  );

  describe('appointments: its query was already a validated DTO', () => {
    it('answers the array for an empty page or limit, as for no paging', async () => {
      await get('appointments?page=&limit=').expect(200);
      const filters = appointments.findAll.mock.calls[0][1];
      expect(filters.page).toBeUndefined();
      expect(filters.limit).toBeUndefined();
    });

    it('keeps rejecting an unknown parameter, as before paging existed', async () => {
      await get('appointments?foo=bar').expect(400);
    });
  });

  describe('patients', () => {
    it('forwards search and status', async () => {
      await get('patients?search=ana&status=inactive').expect(200);
      expect(patients.findAll).toHaveBeenCalledWith('tenant-1', 'ana', {
        status: 'inactive',
        page: undefined,
        limit: undefined,
      });
    });

    it('rejects an unknown status', async () => {
      await get('patients?status=archived').expect(400);
    });

    it('still accepts the isActive the web has always sent, and an empty search', async () => {
      await get('patients?isActive=true&search=').expect(200);
      expect(patients.findAll).toHaveBeenCalledTimes(1);
    });

    it('cuts a search longer than 100 characters instead of rejecting it', async () => {
      await get(`patients?search=${'a'.repeat(300)}`).expect(200);
      expect(patients.findAll.mock.calls[0][1]).toBe('a'.repeat(100));
    });

    it('treats an empty status as not sent', async () => {
      await get('patients?status=').expect(200);
      expect(patients.findAll.mock.calls[0][2].status).toBeUndefined();
    });
  });

  describe('tasks', () => {
    it('forwards the filters with the actor', async () => {
      await get('tasks?status=PENDING&priority=HIGH&assignedToId=u-1&patientId=p-1&page=2').expect(
        200,
      );
      expect(tasks.findAll).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({
          status: 'PENDING',
          priority: 'HIGH',
          assignedToId: 'u-1',
          patientId: 'p-1',
          page: 2,
        }),
        expect.objectContaining({ userId: 'actor-1' }),
      );
    });

    it('rejects a status or priority that is not in the enum instead of failing in the database', async () => {
      await get('tasks?status=DONE').expect(400);
      await get('tasks?priority=NOW').expect(400);
    });

    it('forwards a search and cuts one longer than 100 characters instead of rejecting it', async () => {
      await get('tasks?search=informe').expect(200);
      expect(tasks.findAll.mock.calls[0][1].search).toBe('informe');
      await get(`tasks?search=${'a'.repeat(300)}`).expect(200);
      expect(tasks.findAll.mock.calls[1][1].search).toBe('a'.repeat(100));
    });

    it('routes /tasks/summary to the summary, not to a task called "summary"', async () => {
      tasks.summary.mockResolvedValue({ pending: 1, overdue: 0, completed: 2, cancelled: 3 });
      const res = await get('tasks/summary?priority=HIGH&search=ana').expect(200);
      expect(res.body).toEqual({ pending: 1, overdue: 0, completed: 2, cancelled: 3 });
      expect(tasks.summary).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({ priority: 'HIGH', search: 'ana' }),
        expect.objectContaining({ userId: 'actor-1' }),
      );
      expect(tasks.findOne).not.toHaveBeenCalled();
    });

    it('ignores what the summary does not read (paging, status, anything unknown) and rejects a bad priority', async () => {
      await get('tasks/summary?page=1&status=PENDING&_=1').expect(200);
      expect(tasks.summary.mock.calls[0][1]).toEqual({});
      await get('tasks/summary?priority=NOW').expect(400);
    });

    it('treats empty filters as not sent, as before', async () => {
      await get('tasks?status=&priority=&assignedToId=&patientId=').expect(200);
      const filters = tasks.findAll.mock.calls[0][1];
      expect(filters.status).toBeUndefined();
      expect(filters.priority).toBeUndefined();
    });
  });

  describe('appointments', () => {
    it('keeps its own filters working next to the page', async () => {
      await get('appointments?status=SCHEDULED&from=2026-09-28&page=1&limit=10').expect(200);
      expect(appointments.findAll).toHaveBeenCalledWith(
        'tenant-1',
        expect.objectContaining({ status: 'SCHEDULED', from: '2026-09-28', page: 1, limit: 10 }),
        expect.objectContaining({ userId: 'actor-1' }),
      );
    });
  });
});
