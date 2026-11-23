import { PrismaService } from '../prisma/prisma.service';
import { TaskActor, TasksService } from './tasks.service';

describe('TasksService.findAll paging', () => {
  const tenantId = 'tenant-1';
  const admin: TaskActor = { userId: 'admin-1', role: 'MASTER' };
  const assistant: TaskActor = { userId: 'assistant-1', role: 'ASISTENTE' };
  const professional: TaskActor = { userId: 'pro-1', role: 'PROFESIONAL' };
  const ownTasksOnly = { OR: [{ createdById: 'pro-1' }, { assignedToId: 'pro-1' }] };
  const person = { select: { id: true, firstName: true, lastName: true } };
  const rows = [{ id: 't-1' }, { id: 't-2' }];
  // The unpaged list reads through the client; a page and the summary read inside one transaction.
  const tx = { task: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() } };
  const prisma = {
    task: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
  };
  const service = new TasksService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    prisma.task.findMany.mockResolvedValue(rows);
    tx.task.findMany.mockResolvedValue(rows);
    tx.task.count.mockResolvedValue(41);
  });

  describe('without page or limit (the contract the mobile app and the dashboard rely on)', () => {
    it('queries exactly what it always did and returns the bare array', async () => {
      const result = await service.findAll(tenantId, undefined, admin);

      expect(result).toBe(rows);
      expect(tx.task.count).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.task.findMany.mock.calls[0][0]).toEqual({
        where: { tenantId },
        include: { patient: person, createdBy: person, assignedTo: person },
        orderBy: [{ dueDate: 'asc' }, { priority: 'desc' }],
      });
    });

    it('keeps the order it always had: no status, no id', async () => {
      await service.findAll(tenantId, { status: 'COMPLETED' }, admin);
      expect(prisma.task.findMany.mock.calls[0][0].orderBy).toEqual([
        { dueDate: 'asc' },
        { priority: 'desc' },
      ]);
    });

    it('keeps every filter and the professional limit, with no skip or take', async () => {
      const result = await service.findAll(
        tenantId,
        { patientId: 'patient-1', assignedToId: 'pro-1', status: 'PENDING', priority: 'HIGH' },
        professional,
      );

      expect(Array.isArray(result)).toBe(true);
      const args = prisma.task.findMany.mock.calls[0][0];
      expect(args).not.toHaveProperty('skip');
      expect(args).not.toHaveProperty('take');
      expect(args.where).toEqual({
        tenantId,
        patientId: 'patient-1',
        assignedToId: 'pro-1',
        status: 'PENDING',
        priority: 'HIGH',
        AND: [ownTasksOnly],
      });
    });
  });

  describe('with page or limit', () => {
    it('returns { data, meta } and pages with a deterministic order', async () => {
      const result = await service.findAll(tenantId, { page: 2, limit: 20 }, admin);

      expect(result).toEqual({
        data: rows,
        meta: { page: 2, limit: 20, total: 41, totalPages: 3 },
      });
      expect(tx.task.findMany.mock.calls[0][0]).toMatchObject({
        skip: 20,
        take: 20,
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { priority: 'desc' }, { id: 'asc' }],
      });
    });

    it('defaults to page 1 of 20 when only one of them is sent', async () => {
      await service.findAll(tenantId, { limit: 7 }, admin);
      expect(tx.task.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 7 });

      await service.findAll(tenantId, { page: 3 }, admin);
      expect(tx.task.findMany.mock.calls[1][0]).toMatchObject({ skip: 40, take: 20 });
    });

    it("counts and lists a professional's page with the same ownership limit", async () => {
      await service.findAll(
        tenantId,
        { assignedToId: 'pro-2', status: 'COMPLETED', page: 1, limit: 10 },
        professional,
      );

      const expected = {
        tenantId,
        assignedToId: 'pro-2',
        status: 'COMPLETED',
        AND: [ownTasksOnly],
      };
      expect(tx.task.count.mock.calls[0][0].where).toEqual(expected);
      expect(tx.task.findMany.mock.calls[0][0].where).toEqual(expected);
    });

    it('lets the assistant and the master see the whole clinic, page by page', async () => {
      for (const actor of [admin, assistant]) {
        tx.task.count.mockClear();
        await service.findAll(tenantId, { page: 1 }, actor);
        expect(tx.task.count.mock.calls[0][0].where).toEqual({ tenantId });
      }
    });

    it('searches title, description and patient name in the page and in the total, next to the ownership limit', async () => {
      await service.findAll(tenantId, { search: 'Ana', page: 1 }, professional);

      const expected = {
        tenantId,
        AND: [ownTasksOnly],
        OR: [
          { title: { contains: 'Ana', mode: 'insensitive' } },
          { description: { contains: 'Ana', mode: 'insensitive' } },
          { patient: { firstName: { contains: 'Ana', mode: 'insensitive' } } },
          { patient: { lastName: { contains: 'Ana', mode: 'insensitive' } } },
        ],
      };
      expect(tx.task.count.mock.calls[0][0].where).toEqual(expected);
      expect(tx.task.findMany.mock.calls[0][0].where).toEqual(expected);
    });

    it('escapes %, _ and \\ in all four branches of the search so they match themselves', async () => {
      await service.findAll(tenantId, { search: '50%_a\\', page: 1 }, admin);
      const escaped = '50\\%\\_a\\\\';

      const expected = [
        { title: { contains: escaped, mode: 'insensitive' } },
        { description: { contains: escaped, mode: 'insensitive' } },
        { patient: { firstName: { contains: escaped, mode: 'insensitive' } } },
        { patient: { lastName: { contains: escaped, mode: 'insensitive' } } },
      ];
      expect(tx.task.count.mock.calls[0][0].where.OR).toEqual(expected);
      expect(tx.task.findMany.mock.calls[0][0].where.OR).toEqual(expected);
    });

    it('puts open tasks before completed and cancelled ones: status leads the order of a page', async () => {
      await service.findAll(tenantId, { page: 1 }, admin);

      const { orderBy } = tx.task.findMany.mock.calls[0][0];
      expect(orderBy[0]).toEqual({ status: 'asc' });
      expect(orderBy).toEqual([
        { status: 'asc' },
        { dueDate: 'asc' },
        { priority: 'desc' },
        { id: 'asc' },
      ]);
    });

    it('reads the total and the page in one transaction, through tx, after the RLS context', async () => {
      const order: string[] = [];
      prisma.applyRlsContext.mockImplementation(async () => void order.push('rls'));
      tx.task.count.mockImplementation(async () => (order.push('count'), 41));
      tx.task.findMany.mockImplementation(async () => (order.push('rows'), rows));

      await service.findAll(tenantId, { page: 1 }, admin);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(prisma.applyRlsContext).toHaveBeenCalledWith(tx);
      expect(order).toEqual(['rls', 'count', 'rows']);
      expect(prisma.task.findMany).not.toHaveBeenCalled();
      expect(prisma.task.count).not.toHaveBeenCalled();
    });

    it('does not run the count and the page at the same time (RLS wrapper shares its context)', async () => {
      let running = 0;
      let overlapped = false;
      const track =
        <T>(value: T) =>
        async () => {
          running += 1;
          overlapped = overlapped || running > 1;
          await new Promise((resolve) => setImmediate(resolve));
          running -= 1;
          return value;
        };
      tx.task.count.mockImplementation(track(41));
      tx.task.findMany.mockImplementation(track(rows));

      await service.findAll(tenantId, { page: 1 }, admin);

      expect(overlapped).toBe(false);
    });
  });

  describe('summary', () => {
    beforeEach(() => {
      tx.task.groupBy.mockResolvedValue([
        { status: 'PENDING', _count: { _all: 5 } },
        { status: 'IN_PROGRESS', _count: { _all: 2 } },
        { status: 'COMPLETED', _count: { _all: 9 } },
      ]);
      tx.task.count.mockResolvedValue(3);
    });

    it('adds PENDING and IN_PROGRESS, counts the overdue ones and reports zero for a missing state', async () => {
      const result = await service.summary(tenantId, undefined, admin);

      expect(result).toEqual({ pending: 7, overdue: 3, completed: 9, cancelled: 0 });
      expect(tx.task.groupBy.mock.calls[0][0]).toEqual({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      });
      const overdueWhere = tx.task.count.mock.calls[0][0].where;
      expect(overdueWhere).toMatchObject({ tenantId, status: { in: ['PENDING', 'IN_PROGRESS'] } });
      expect(overdueWhere.dueDate.lt).toBeInstanceOf(Date);
    });

    it('runs both queries in one transaction, through tx', async () => {
      const order: string[] = [];
      prisma.applyRlsContext.mockImplementation(async () => void order.push('rls'));
      tx.task.groupBy.mockImplementation(async () => (order.push('groupBy'), []));
      tx.task.count.mockImplementation(async () => (order.push('count'), 0));

      await service.summary(tenantId, undefined, admin);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['rls', 'groupBy', 'count']);
      expect(prisma.task.count).not.toHaveBeenCalled();
    });

    it("keeps a professional's own-tasks limit and the filters in every query", async () => {
      await service.summary(tenantId, { priority: 'HIGH', search: 'Ana' }, professional);

      for (const call of [tx.task.groupBy, tx.task.count]) {
        const where = call.mock.calls[0][0].where;
        expect(where).toMatchObject({ tenantId, priority: 'HIGH', AND: [ownTasksOnly] });
        expect(where.OR).toHaveLength(4);
      }
    });
  });
});
