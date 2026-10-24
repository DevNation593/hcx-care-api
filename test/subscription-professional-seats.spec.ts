import { SubscriptionService } from '../src/subscription/subscription.service';
import { PrismaService } from '../src/prisma/prisma.service';

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
});
