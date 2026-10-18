import { SubscriptionService } from '../src/subscription/subscription.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

describe('Subscription professional seats', () => {
  const tenantId = 'clinic-1';
  let service: SubscriptionService;
  let db: any;

  beforeEach(() => {
    db = {
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue({
          seatsPsychologistsMax: 3,
          maxActivePatients: 10,
          storageGB: 1,
          storageUsedBytes: 0n,
          monthlyNotificationsLimit: 100,
          currentPeriodStart: new Date('2026-09-01'),
          currentPeriodEnd: new Date('2026-10-01'),
        }),
      },
      professionalProfile: { count: jest.fn().mockResolvedValue(1) },
      user: { count: jest.fn().mockResolvedValue(0) },
      patient: { count: jest.fn().mockResolvedValue(0) },
      notificationLog: { count: jest.fn().mockResolvedValue(0) },
      appointment: { count: jest.fn().mockResolvedValue(0) },
      clinicalNote: { count: jest.fn().mockResolvedValue(0) },
      invoiceRequest: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new SubscriptionService(db as PrismaService);
  });

  it('reports active profile seats when there are no PSICOLOGO users', async () => {
    const result = await service.getUsageMetrics(tenantId);
    expect(result.usage.seats).toMatchObject({ used: 1, limit: 3, available: 2 });
    expect(db.professionalProfile.count).toHaveBeenCalledWith({
      where: { isActive: true, user: { tenantId } },
    });
    expect(db.user.count).not.toHaveBeenCalled();
  });

  it('counts an active administrator profile in usage seats', async () => {
    db.professionalProfile.count.mockResolvedValue(2);
    const result = await service.getUsageMetrics(tenantId);
    expect(result.usage.seats).toMatchObject({ used: 2, available: 1 });
  });

  it('reports live active profiles in the legacy current-subscription seat fields', async () => {
    db.tenantSubscription.findUnique.mockResolvedValue({
      seatsPsychologistsMax: 3,
      seatsPsychologistsUsed: 99,
      specialties: [],
      tenant: { name: 'Clinic', email: 'clinic@test.invalid' },
    });
    // Includes a clinical administrator; there are no PSICOLOGO users.
    db.professionalProfile.count.mockResolvedValue(2);

    const result = await service.getCurrentSubscription(tenantId);

    expect(result.subscription).toMatchObject({
      seatsPsychologistsMax: 3,
      seatsPsychologistsUsed: 2,
      seatsAvailable: 1,
    });
    expect(result.tenant).toEqual({ name: 'Clinic', email: 'clinic@test.invalid' });
    expect(db.professionalProfile.count).toHaveBeenCalledWith({
      where: { isActive: true, user: { tenantId } },
    });
    expect(db.user.count).not.toHaveBeenCalled();
  });

  it('blocks downgrade when profiles exceed the new professional seat limit', async () => {
    db.professionalProfile.count.mockResolvedValue(2);
    const result = await service['validateDowngrade'](tenantId, {
      seatsIncluded: 1,
      maxActivePatients: 10,
      storageGB: 1,
      planType: 'PERSONAL_BASIC',
    });
    expect(result.canDowngrade).toBe(false);
    expect(result.errors.join(' ')).toContain('2 profesionales activos');
    expect(db.user.count).not.toHaveBeenCalled();
  });

  it('charges both commercial and specialty add-ons when customizing features', async () => {
    const subscription = {
      planType: 'CLINIC_BASIC',
      status: 'ACTIVE',
      currency: 'USD',
      specialtyPrice: new Decimal(15),
    };
    db.tenantSubscription.findUnique.mockResolvedValue({
      ...subscription,
      specialtyPrice: new Decimal(12),
    });
    db.tenantSpecialty = { count: jest.fn().mockResolvedValue(2) };
    db.applyRlsContext = jest.fn().mockResolvedValue(undefined);
    const tx = {
      tenantSubscription: {
        findUnique: jest.fn().mockResolvedValue(subscription),
        update: jest.fn().mockImplementation(async ({ data }) => data),
      },
      tenantSpecialty: { count: jest.fn().mockResolvedValue(4) },
      subscriptionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    db.$transaction = jest
      .fn()
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementation(async (callback) => callback(tx));

    const result = await service.customizeFeatures(tenantId, 'user-1', [
      'clinicalNotes',
      'attachments',
      'advancedAnalytics',
      'advancedAnalytics',
    ]);
    const updated = await tx.tenantSubscription.update.mock.results[0].value;

    expect(updated.basePrice.toNumber()).toBe(139);
    expect(result.pricing).toMatchObject({
      featureAddonsPrice: 10,
      specialtyAddonsPrice: 30,
      totalMonthly: 139,
      addonsCost: 10,
    });
    expect(tx.tenantSubscription.findUnique).toHaveBeenCalled();
    expect(tx.tenantSpecialty.count).toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });
});
