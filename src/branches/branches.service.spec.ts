import { PrismaService } from '../prisma/prisma.service';
import {
  assertBranchAvailable,
  assertProfessionalInBranch,
  BranchesService,
} from './branches.service';

describe('BranchesService', () => {
  const branch = (overrides = {}) => ({
    id: 'branch-1',
    tenantId: 'tenant-1',
    name: 'Sede principal',
    isMain: true,
    isActive: true,
    ...overrides,
  });
  const db = {
    tenant: { findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    professionalBranch: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
    branch: {
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const service = new BranchesService(prisma as unknown as PrismaService);

  /** `active` branches in use and `main` branches flagged, as the two counts the service asks for. */
  const counts = ({ active = 0, main = 0 }) =>
    db.branch.count.mockImplementation(({ where }) =>
      Promise.resolve(where.isMain ? main : active),
    );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.tenant.findUnique.mockResolvedValue({
      tenantType: 'CLINIC',
      subscription: { maxBranches: 2 },
    });
    db.branch.create.mockImplementation(({ data }) => Promise.resolve(data));
    db.branch.update.mockImplementation(({ data }) => Promise.resolve(data));
    counts({ active: 1, main: 1 });
  });

  it('lists the branches of the tenant, the main one first, with their professionals', async () => {
    db.branch.findMany.mockResolvedValue([
      { ...branch(), professionals: [{ userId: 'pro-1' }, { userId: 'pro-2' }] },
    ]);

    const [listed] = await service.list('tenant-1');

    expect(db.branch.findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
      include: { professionals: { select: { userId: true } } },
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    });
    expect(listed).toMatchObject({ id: 'branch-1', professionalIds: ['pro-1', 'pro-2'] });
    expect(listed).not.toHaveProperty('professionals');
  });

  describe('setProfessionals', () => {
    beforeEach(() => db.branch.findFirst.mockResolvedValue({ id: 'branch-1' }));

    it('replaces the professionals of the branch with active ones of the clinic', async () => {
      db.user.findMany.mockResolvedValue([{ id: 'pro-1' }, { id: 'pro-2' }]);

      const result = await service.setProfessionals('tenant-1', 'branch-1', [
        'pro-1',
        'pro-2',
        'pro-1',
      ]);

      expect(db.user.findMany.mock.calls[0][0].where).toEqual({
        id: { in: ['pro-1', 'pro-2'] },
        tenantId: 'tenant-1',
        isActive: true,
        professionalProfile: { isActive: true },
      });
      expect(db.professionalBranch.deleteMany).toHaveBeenCalledWith({
        where: { branchId: 'branch-1', tenantId: 'tenant-1' },
      });
      expect(db.professionalBranch.createMany).toHaveBeenCalledWith({
        data: [
          { userId: 'pro-1', branchId: 'branch-1', tenantId: 'tenant-1' },
          { userId: 'pro-2', branchId: 'branch-1', tenantId: 'tenant-1' },
        ],
      });
      expect(result).toEqual({ branchId: 'branch-1', professionalIds: ['pro-1', 'pro-2'] });
    });

    it('removes every assignment with an empty list', async () => {
      db.user.findMany.mockResolvedValue([]);

      await service.setProfessionals('tenant-1', 'branch-1', []);

      expect(db.professionalBranch.deleteMany).toHaveBeenCalled();
      expect(db.professionalBranch.createMany).not.toHaveBeenCalled();
    });

    it('refuses anyone who is not an active professional of the clinic', async () => {
      db.user.findMany.mockResolvedValue([{ id: 'pro-1' }]);

      await expect(
        service.setProfessionals('tenant-1', 'branch-1', ['pro-1', 'assistant-1']),
      ).rejects.toMatchObject({ status: 400, response: { code: 'BRANCH_PROFESSIONAL_INVALID' } });
      expect(db.professionalBranch.deleteMany).not.toHaveBeenCalled();
    });

    it('does not find a branch of another tenant', async () => {
      db.branch.findFirst.mockResolvedValue(null);

      await expect(service.setProfessionals('tenant-1', 'foreign', [])).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('assertProfessionalInBranch', () => {
    const check = (branchId: string) =>
      assertProfessionalInBranch(db as unknown as PrismaService, 'tenant-1', 'pro-1', branchId);

    it('lets a professional tied to no branch attend anywhere', async () => {
      db.professionalBranch.findMany.mockResolvedValue([]);

      await expect(check('branch-1')).resolves.toBeUndefined();
      expect(db.professionalBranch.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        userId: 'pro-1',
      });
    });

    it('keeps a professional tied to some branches within them', async () => {
      db.professionalBranch.findMany.mockResolvedValue([{ branchId: 'branch-1' }]);

      await expect(check('branch-1')).resolves.toBeUndefined();
      await expect(check('branch-2')).rejects.toMatchObject({
        status: 409,
        response: { code: 'PROFESSIONAL_NOT_IN_BRANCH' },
      });
    });
  });

  describe('create', () => {
    it('stores trimmed data and distinct room names', async () => {
      await service.create('tenant-1', {
        name: '  Sede Cumbayá ',
        city: ' ',
        rooms: ['Consultorio 1', ' Consultorio 1 ', '', 'Consultorio 2'],
      });

      expect(db.branch.create.mock.calls[0][0].data).toEqual({
        tenantId: 'tenant-1',
        name: 'Sede Cumbayá',
        address: null,
        city: null,
        phone: null,
        openingHours: null,
        rooms: ['Consultorio 1', 'Consultorio 2'],
        isMain: false,
      });
    });

    it('makes the first branch of a clinic its main one', async () => {
      counts({ active: 0, main: 0 });

      await service.create('tenant-1', { name: 'Única' });

      expect(db.branch.create.mock.calls[0][0].data.isMain).toBe(true);
    });

    it('keeps a personal practice to a single active branch whatever its plan says', async () => {
      db.tenant.findUnique.mockResolvedValue({
        tenantType: 'PERSONAL',
        subscription: { maxBranches: 5 },
      });

      await expect(service.create('tenant-1', { name: 'Segunda' })).rejects.toMatchObject({
        status: 409,
        response: { code: 'BRANCH_LIMIT_REACHED', limit: 1 },
      });
      expect(db.branch.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isActive: true },
      });
      expect(db.branch.create).not.toHaveBeenCalled();
    });

    it('lets a clinic open branches up to what its plan includes', async () => {
      await service.create('tenant-1', { name: 'Segunda' });
      expect(db.branch.create).toHaveBeenCalled();

      counts({ active: 2, main: 1 });
      await expect(service.create('tenant-1', { name: 'Tercera' })).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'BRANCH_LIMIT_REACHED',
          limit: 2,
          message: 'Tu plan incluye hasta 2 sedes activas.',
        },
      });
    });

    it('treats a name that differs only in case as taken', async () => {
      prisma.branch.findFirst.mockResolvedValue({ id: 'branch-1' });

      await expect(service.create('tenant-1', { name: ' sede PRINCIPAL ' })).rejects.toMatchObject({
        status: 409,
        response: { code: 'BRANCH_NAME_TAKEN' },
      });
      expect(prisma.branch.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', name: { equals: 'sede PRINCIPAL', mode: 'insensitive' } },
        select: { id: true },
      });
      expect(prisma.branch.create).not.toHaveBeenCalled();
    });

    it('answers 409 when the name is taken', async () => {
      db.branch.create.mockRejectedValue(Object.assign(new Error('Unique'), { code: 'P2002' }));

      await expect(service.create('tenant-1', { name: 'Sede principal' })).rejects.toMatchObject({
        status: 409,
        response: { code: 'BRANCH_NAME_TAKEN' },
      });
    });
  });

  describe('update', () => {
    it('does not find a branch of another tenant', async () => {
      db.branch.findFirst.mockResolvedValue(null);

      await expect(service.update('tenant-1', 'foreign', { name: 'X' })).rejects.toMatchObject({
        status: 404,
      });
      expect(db.branch.findFirst.mock.calls[0][0].where).toEqual({
        id: 'foreign',
        tenantId: 'tenant-1',
      });
    });

    it('moves the main flag to another branch', async () => {
      db.branch.findFirst.mockResolvedValue(branch({ id: 'branch-2', isMain: false }));

      await service.update('tenant-1', 'branch-2', { isMain: true });

      expect(db.branch.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isMain: true },
        data: { isMain: false },
      });
      expect(db.branch.update.mock.calls[0][0].data).toMatchObject({ isMain: true });
    });

    it('refuses to leave the clinic without an active main branch', async () => {
      db.branch.findFirst.mockResolvedValue(branch());

      await expect(
        service.update('tenant-1', 'branch-1', { isActive: false }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'BRANCH_MAIN_REQUIRED' } });
      await expect(service.update('tenant-1', 'branch-1', { isMain: false })).rejects.toMatchObject(
        { status: 409, response: { code: 'BRANCH_MAIN_REQUIRED' } },
      );
      expect(db.branch.update).not.toHaveBeenCalled();
    });

    it('deactivates a secondary branch without checking the limit', async () => {
      db.branch.findFirst.mockResolvedValue(branch({ id: 'branch-2', isMain: false }));

      await service.update('tenant-1', 'branch-2', { isActive: false });

      expect(db.branch.update.mock.calls[0][0].data).toEqual({ isActive: false, isMain: false });
      expect(db.tenant.findUnique).not.toHaveBeenCalled();
    });

    it('counts a reactivated branch against the limit', async () => {
      db.tenant.findUnique.mockResolvedValue({ tenantType: 'PERSONAL' });
      db.branch.findFirst.mockResolvedValue(
        branch({ id: 'branch-2', isMain: false, isActive: false }),
      );

      await expect(
        service.update('tenant-1', 'branch-2', { isActive: true }),
      ).rejects.toMatchObject({ status: 409, response: { code: 'BRANCH_LIMIT_REACHED' } });
    });
  });

  describe('assertBranchAvailable', () => {
    it('accepts only an active branch of the tenant', async () => {
      db.branch.findFirst.mockResolvedValueOnce({ id: 'branch-1' });
      await expect(
        assertBranchAvailable(db as unknown as PrismaService, 'tenant-1', 'branch-1'),
      ).resolves.toBeUndefined();
      expect(db.branch.findFirst.mock.calls[0][0].where).toEqual({
        id: 'branch-1',
        tenantId: 'tenant-1',
        isActive: true,
      });

      db.branch.findFirst.mockResolvedValueOnce(null);
      await expect(
        assertBranchAvailable(db as unknown as PrismaService, 'tenant-1', 'other'),
      ).rejects.toMatchObject({ status: 400, response: { code: 'BRANCH_NOT_AVAILABLE' } });
    });
  });
});
