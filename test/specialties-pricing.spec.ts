import { Decimal } from '@prisma/client/runtime/library';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { SpecialtyCatalogService } from '../src/specialties/specialty-catalog.service';
import { TenantSpecialtiesService } from '../src/specialties/tenant-specialties.service';

describe('Specialty selection pricing', () => {
  it('writes an absolute price from the transactional subscription snapshot', async () => {
    const subscription = {
      planType: 'CLINIC_BASIC',
      includedSpecialties: 2,
      specialtyPrice: new Decimal(15),
      basePrice: new Decimal(99),
      featureClinicalNotes: true,
      featureAdvancedAnalytics: true,
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
    await selection.replace('clinic-1', ['A', 'B', 'C', 'D'], 'user-1');

    expect(tx.tenantSubscription.update).toHaveBeenCalledWith({
      where: { tenantId: 'clinic-1' },
      data: { basePrice: new Decimal(139) },
    });
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
