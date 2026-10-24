import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { SpecialtyCatalogService } from '../src/specialties/specialty-catalog.service';
import { TenantSpecialtiesService } from '../src/specialties/tenant-specialties.service';

describe('Specialty selection pricing', () => {
  it('prices the selection from the transactional subscription snapshot, leaving the plan price', async () => {
    const subscription = {
      planId: 'plan_clinic_basic',
      includedSpecialties: 2,
      specialtyPrice: new Decimal(15),
      basePrice: new Decimal(99),
    };
    const tx = {
      specialty: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', code: 'A', name: 'A', description: null, modules: [] },
          { id: 'b', code: 'B', name: 'B', description: null, modules: [] },
          { id: 'c', code: 'C', name: 'C', description: null, modules: [] },
          { id: 'd', code: 'D', name: 'D', description: null, modules: [] },
        ]),
      },
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({ ...subscription, id: 'sub-1', currency: 'USD' }),
        update: jest.fn().mockResolvedValue({}),
      },
      tenantSpecialty: {
        findMany: jest.fn().mockResolvedValue([{ specialtyId: 'a' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      subscriptionSpecialty: {
        findMany: jest.fn().mockResolvedValue([{ specialtyId: 'a' }]),
        createMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      tenantModule: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      auditLog: { create: jest.fn() },
    };
    const db: any = {
      applyRlsContext: jest.fn().mockResolvedValue(undefined),
      $transaction: jest
        .fn()
        .mockRejectedValueOnce({ code: 'P2034' })
        .mockImplementation(async (callback) => callback(tx)),
    };
    const selection = new TenantSpecialtiesService(
      db as PrismaService,
      new SpecialtyCatalogService(db as PrismaService),
    );
    const result = await selection.replace('clinic-1', ['A', 'B', 'C', 'D'], 'user-1');

    // 99 + 2 specialties beyond the 2 included, at 15.
    expect(result.pricing).toMatchObject({
      basePlanPrice: 99,
      billableSpecialties: 2,
      specialtyAddonsPrice: 30,
      totalMonthly: 129,
    });
    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.findUnique).toHaveBeenCalledWith({
      where: { tenantId: 'clinic-1' },
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'clinic-1', userId: 'user-1' }),
      }),
    );
  });
});
