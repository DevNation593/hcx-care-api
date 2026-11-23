import { PatientTeamService } from '../patient-team/patient-team.service';
import { PrismaService } from '../prisma/prisma.service';
import { LEGACY_BILLING_OMIT } from './legacy-billing';
import { PatientsService } from './patients.service';

describe('PatientsService.findAll paging', () => {
  const tenantId = 'tenant-1';
  const assignee = {
    select: { id: true, firstName: true, lastName: true, email: true, avatarUrl: true, role: true },
  };
  const rows = [{ id: 'p-1' }, { id: 'p-2' }];
  // The unpaged list reads through the client; a page reads inside one transaction, on `tx`.
  const tx = { patient: { findMany: jest.fn(), count: jest.fn() } };
  const prisma = {
    patient: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
  };
  const service = new PatientsService(
    prisma as unknown as PrismaService,
    {} as unknown as PatientTeamService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    prisma.patient.findMany.mockResolvedValue(rows);
    tx.patient.findMany.mockResolvedValue(rows);
    tx.patient.count.mockResolvedValue(45);
  });

  describe('without page or limit (the contract the mobile app and the selectors rely on)', () => {
    it('queries exactly what it always did and returns the bare array', async () => {
      const result = await service.findAll(tenantId);

      expect(result).toBe(rows);
      expect(tx.patient.count).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.patient.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.patient.findMany.mock.calls[0][0]).toEqual({
        where: { tenantId, isActive: true, deletedAt: null },
        omit: LEGACY_BILLING_OMIT,
        orderBy: { lastName: 'asc' },
        include: { assignedPsychologist: assignee },
      });
    });

    it('keeps the search filter and still returns the array', async () => {
      const result = await service.findAll(tenantId, 'Ana');

      expect(Array.isArray(result)).toBe(true);
      const args = prisma.patient.findMany.mock.calls[0][0];
      expect(args).not.toHaveProperty('skip');
      expect(args).not.toHaveProperty('take');
      expect(args.where.OR).toHaveLength(5);
    });

    it('treats an empty options object like no options', async () => {
      expect(Array.isArray(await service.findAll(tenantId, undefined, {}))).toBe(true);
      expect(Array.isArray(await service.findAll(tenantId, undefined, { status: 'all' }))).toBe(
        true,
      );
      expect(tx.patient.count).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('with page or limit', () => {
    it('returns { data, meta } and pages with a deterministic order', async () => {
      const result = await service.findAll(tenantId, undefined, { page: 3, limit: 20 });

      expect(result).toEqual({
        data: rows,
        meta: { page: 3, limit: 20, total: 45, totalPages: 3 },
      });
      expect(tx.patient.findMany.mock.calls[0][0]).toMatchObject({
        skip: 40,
        take: 20,
        orderBy: [{ lastName: 'asc' }, { id: 'asc' }],
      });
    });

    it('defaults to page 1 of 20 when only one of them is sent', async () => {
      await service.findAll(tenantId, undefined, { limit: 5 });
      expect(tx.patient.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 5 });

      await service.findAll(tenantId, undefined, { page: 2 });
      expect(tx.patient.findMany.mock.calls[1][0]).toMatchObject({ skip: 20, take: 20 });
    });

    it('counts and lists with the very same where, keeping tenant, deletedAt, isActive and search', async () => {
      await service.findAll(tenantId, 'Ana', { page: 1, limit: 10 });

      const listed = tx.patient.findMany.mock.calls[0][0].where;
      const counted = tx.patient.count.mock.calls[0][0].where;
      expect(counted).toBe(listed);
      expect(listed).toMatchObject({ tenantId, isActive: true, deletedAt: null });
      expect(listed.OR).toHaveLength(5);
    });

    it('keeps the omitted billing columns and the assignee projection', async () => {
      await service.findAll(tenantId, undefined, { page: 1 });
      expect(tx.patient.findMany.mock.calls[0][0]).toMatchObject({
        omit: LEGACY_BILLING_OMIT,
        include: { assignedPsychologist: assignee },
      });
    });

    it('reports zero pages for an empty result', async () => {
      tx.patient.count.mockResolvedValue(0);
      tx.patient.findMany.mockResolvedValue([]);

      await expect(service.findAll(tenantId, 'zzz', { page: 1 })).resolves.toEqual({
        data: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
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
      tx.patient.count.mockImplementation(track(45));
      tx.patient.findMany.mockImplementation(track(rows));

      await service.findAll(tenantId, undefined, { page: 1 });

      expect(overlapped).toBe(false);
    });
  });

  describe('one transaction per page', () => {
    it('applies the RLS context to the transaction and reads only through it', async () => {
      await service.findAll(tenantId, undefined, { page: 1 });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'RepeatableRead' });
      expect(prisma.applyRlsContext).toHaveBeenCalledWith(tx);
      // The outer client (which would open its own transaction per query) is not used.
      expect(prisma.patient.findMany).not.toHaveBeenCalled();
      expect(prisma.patient.count).not.toHaveBeenCalled();
      expect(tx.patient.count).toHaveBeenCalledTimes(1);
      expect(tx.patient.findMany).toHaveBeenCalledTimes(1);
    });

    it('sets the RLS context before the first read', async () => {
      const order: string[] = [];
      prisma.applyRlsContext.mockImplementation(async () => void order.push('rls'));
      tx.patient.count.mockImplementation(async () => (order.push('count'), 45));
      tx.patient.findMany.mockImplementation(async () => (order.push('rows'), rows));

      await service.findAll(tenantId, undefined, { page: 1 });

      expect(order).toEqual(['rls', 'count', 'rows']);
    });
  });

  describe('search term', () => {
    it.each(['-', '- -', '  ', '--'])(
      'leaves the identification out of a term made only of spaces and hyphens (%j)',
      async (term) => {
        await service.findAll(tenantId, term);
        const branches = prisma.patient.findMany.mock.calls[0][0].where.OR;
        expect(branches).toHaveLength(4);
        expect(JSON.stringify(branches)).not.toContain('identificationNumber');
      },
    );

    it('keeps the normalized identification for a real term', async () => {
      await service.findAll(tenantId, '171234567-8');
      expect(prisma.patient.findMany.mock.calls[0][0].where.OR).toContainEqual({
        identificationNumber: { contains: '1712345678' },
      });
    });
  });

  describe('status filter', () => {
    it.each([
      ['active', { isActive: true }],
      ['inactive', { isActive: false }],
    ] as const)('lists only %s patients', async (status, expected) => {
      await service.findAll(tenantId, undefined, { status });
      expect(prisma.patient.findMany.mock.calls[0][0].where).toEqual({
        tenantId,
        deletedAt: null,
        ...expected,
      });
    });

    it('lists both states but never a deleted patient', async () => {
      await service.findAll(tenantId, undefined, { status: 'all' });
      expect(prisma.patient.findMany.mock.calls[0][0].where).toEqual({
        tenantId,
        deletedAt: null,
      });
    });

    it('applies the status to the count of a page too', async () => {
      await service.findAll(tenantId, undefined, { status: 'inactive', page: 1 });
      expect(tx.patient.count.mock.calls[0][0].where).toEqual({
        tenantId,
        deletedAt: null,
        isActive: false,
      });
    });
  });
});

describe('patient search escaping', () => {
  it('is applied to every branch of a search, identification included', async () => {
    const reads = { patient: { findMany: jest.fn().mockResolvedValue([]) } };
    const reader = new PatientsService(
      reads as unknown as PrismaService,
      {} as unknown as PatientTeamService,
    );

    await reader.findAll('tenant-1', '50%_x');

    expect(reads.patient.findMany.mock.calls[0][0].where.OR).toEqual([
      { firstName: { contains: '50\\%\\_x', mode: 'insensitive' } },
      { lastName: { contains: '50\\%\\_x', mode: 'insensitive' } },
      { email: { contains: '50\\%\\_x', mode: 'insensitive' } },
      { phone: { contains: '50\\%\\_x' } },
      { identificationNumber: { contains: '50\\%\\_X' } },
    ]);
  });
});
