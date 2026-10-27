import { PrismaService } from '../prisma/prisma.service';
import { TaskActor, TasksService } from './tasks.service';

import { LEGACY_BILLING_OMIT } from '../patients/legacy-billing';

describe('TasksService visibility per professional', () => {
  const tenantId = 'tenant-1';
  const admin: TaskActor = { userId: 'admin-1', role: 'MASTER' };
  const assistant: TaskActor = { userId: 'assistant-1', role: 'ASISTENTE' };
  const professional: TaskActor = { userId: 'pro-1', role: 'PROFESIONAL' };
  const task = (overrides: Record<string, unknown> = {}) => ({
    id: 'task-1',
    tenantId,
    patientId: 'patient-1',
    createdById: 'pro-1',
    assignedToId: 'pro-1',
    status: 'PENDING',
    ...overrides,
  });
  const prisma = {
    patient: { findFirst: jest.fn() },
    user: { findFirst: jest.fn() },
    task: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  let service: TasksService;
  const ownTasksOnly = { OR: [{ createdById: 'pro-1' }, { assignedToId: 'pro-1' }] };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.patient.findFirst.mockResolvedValue({ id: 'patient-1', tenantId });
    prisma.user.findFirst.mockResolvedValue({
      id: 'someone',
      tenantId,
      isActive: true,
      role: 'PROFESIONAL',
    });
    prisma.task.findMany.mockResolvedValue([]);
    prisma.task.findFirst.mockResolvedValue(task());
    prisma.task.create.mockImplementation(async ({ data }) => ({ id: 'task-new', ...data }));
    prisma.task.update.mockImplementation(async ({ data }) => task(data));
    service = new TasksService(prisma as unknown as PrismaService);
  });

  describe('listing', () => {
    it.each([professional])(
      'limits a professional ($role) to tasks they created or were assigned',
      async (actor) => {
        await service.findAll(tenantId, {}, actor);
        expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({
          tenantId,
          AND: [ownTasksOnly],
        });
      },
    );

    it('keeps the ownership limit when a professional filters by another assignee', async () => {
      await service.findAll(
        tenantId,
        { assignedToId: 'pro-2', patientId: 'patient-1' },
        professional,
      );
      expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({
        tenantId,
        patientId: 'patient-1',
        assignedToId: 'pro-2',
        AND: [ownTasksOnly],
      });
    });

    it.each([admin, assistant])('shows every clinic task to $role', async (actor) => {
      await service.findAll(tenantId, {}, actor);
      expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({ tenantId });
    });
  });

  describe('reading one task', () => {
    it("hides another professional's task as not found", async () => {
      prisma.task.findFirst.mockResolvedValue(null);
      await expect(service.findOne(tenantId, 'task-1', professional)).rejects.toMatchObject({
        status: 404,
      });
      expect(prisma.task.findFirst.mock.calls[0][0].where).toEqual({
        id: 'task-1',
        tenantId,
        AND: [ownTasksOnly],
      });
    });

    it('leaves the legacy billing columns of the patient out of the response', async () => {
      await service.findOne(tenantId, 'task-1', admin);
      expect(prisma.task.findFirst.mock.calls[0][0].include.patient).toEqual({
        omit: LEGACY_BILLING_OMIT,
      });
    });

    it('lets an administrator read any task', async () => {
      await service.findOne(tenantId, 'task-1', admin);
      expect(prisma.task.findFirst.mock.calls[0][0].where).toEqual({ id: 'task-1', tenantId });
    });
  });

  describe('updating', () => {
    it('does not let a professional change a task that is not theirs', async () => {
      prisma.task.findFirst.mockResolvedValue(null);
      await expect(
        service.update(tenantId, 'task-1', { title: 'Cambio' }, professional),
      ).rejects.toMatchObject({ status: 404 });
      expect(prisma.task.findFirst.mock.calls[0][0].where).toEqual({
        id: 'task-1',
        tenantId,
        AND: [ownTasksOnly],
      });
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('does not let a professional hand a task to someone else', async () => {
      await expect(
        service.update(tenantId, 'task-1', { assignedToId: 'pro-2' }, professional),
      ).rejects.toMatchObject({ status: 403, response: { code: 'TASK_ASSIGNMENT_FORBIDDEN' } });
      expect(prisma.task.update).not.toHaveBeenCalled();
    });

    it('lets a professional update their own task and keep it assigned to themselves', async () => {
      await service.update(
        tenantId,
        'task-1',
        { status: 'COMPLETED', assignedToId: 'pro-1' },
        professional,
      );
      expect(prisma.task.update.mock.calls[0][0].data).toMatchObject({
        status: 'COMPLETED',
        assignedToId: 'pro-1',
        completedAt: expect.any(Date),
      });
    });

    it('lets an administrator reassign any task', async () => {
      await service.update(tenantId, 'task-1', { assignedToId: 'pro-2' }, admin);
      expect(prisma.task.update.mock.calls[0][0].data).toMatchObject({ assignedToId: 'pro-2' });
    });
  });

  describe('creating', () => {
    const input = { title: 'Llamar', patientId: 'patient-1', priority: 'MEDIUM' };

    it('does not let a professional create a task for someone else', async () => {
      await expect(
        service.create(tenantId, professional, { ...input, assignedToId: 'pro-2' } as never),
      ).rejects.toMatchObject({ status: 403, response: { code: 'TASK_ASSIGNMENT_FORBIDDEN' } });
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it("assigns a professional's new task to themselves when no assignee is given", async () => {
      await service.create(tenantId, professional, input as never);
      const data = prisma.task.create.mock.calls[0][0].data;
      expect(data.assignedTo).toEqual({ connect: { id: 'pro-1' } });
      expect(data.createdBy).toEqual({ connect: { id: 'pro-1' } });
    });

    it('refuses to assign a task to a cashier', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'cashier-1',
        tenantId,
        isActive: true,
        role: 'CAJERO',
      });
      await expect(
        service.create(tenantId, admin, { ...input, assignedToId: 'cashier-1' } as never),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          statusCode: 400,
          code: 'TASK_ASSIGNEE_NOT_ALLOWED',
          message: 'Solo se pueden asignar actividades al titular, a profesionales o a asistentes.',
        },
      });
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it('lets an administrator assign a task to any clinic user', async () => {
      await service.create(tenantId, admin, { ...input, assignedToId: 'pro-2' } as never);
      expect(prisma.task.create.mock.calls[0][0].data.assignedTo).toEqual({
        connect: { id: 'pro-2' },
      });
    });
  });
});
