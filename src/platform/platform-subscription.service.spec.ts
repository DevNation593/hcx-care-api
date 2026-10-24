import { Prisma } from '@prisma/client';
import { PlatformSubscriptionService } from './platform-subscription.service';

const ACTOR = 'admin-1';
const TENANT = 'tenant-1';

const basic = {
  id: 'plan_clinic_basic',
  code: 'CLINIC_BASIC',
  tenantType: 'CLINIC',
  basePrice: new Prisma.Decimal(99),
  pricePerSeat: new Prisma.Decimal(15),
  specialtyPrice: new Prisma.Decimal(15),
  currency: 'USD',
  seatsIncluded: 3,
  maxActivePatients: 150,
  storageGB: 10,
  monthlyElectronicInvoicesLimit: 50,
  includedSpecialties: 2,
  modules: [],
};
const pro = {
  ...basic,
  id: 'plan_clinic_pro',
  code: 'CLINIC_PRO',
  basePrice: new Prisma.Decimal(199),
  seatsIncluded: 10,
  maxActivePatients: 500,
};

describe('PlatformSubscriptionService', () => {
  let subscription: any;
  let updates: any[];
  let events: any[];
  let tenants: any;
  let plans: { findAssignable: jest.Mock; assign: jest.Mock };
  let audit: { record: jest.Mock };
  let tx: any;
  let prisma: any;
  let service: PlatformSubscriptionService;

  beforeEach(() => {
    subscription = {
      tenantId: TENANT,
      planId: basic.id,
      plan: basic,
      status: 'ACTIVE',
      trialEndsAt: null,
      currentPeriodStart: new Date('2026-09-20T00:00:00Z'),
      currentPeriodEnd: new Date('2099-10-20T00:00:00Z'),
      basePrice: basic.basePrice,
      seatsPsychologistsMax: 3,
      seatsPsychologistsUsed: 2,
      maxActivePatients: 150,
      activePatientsCount: 140,
      storageGB: 10,
      overriddenFields: [],
    };
    updates = [];
    events = [];
    tenants = {
      findOne: jest.fn(async (id: string) => ({ tenant: { id, tenantType: 'CLINIC' } })),
    };
    plans = {
      findAssignable: jest.fn(async (_tx, planId: string) => (planId === pro.id ? pro : basic)),
      assign: jest.fn(async () => undefined),
    };
    tx = {
      tenantSubscription: {
        findUniqueOrThrow: jest.fn(async () => subscription),
        update: jest.fn(async ({ data }) => {
          updates.push(data);
          subscription = { ...subscription, ...data };
          return subscription;
        }),
      },
      subscriptionEvent: { create: jest.fn(async ({ data }) => events.push(data)) },
    };
    prisma = {
      applyRlsContext: jest.fn(async () => undefined),
      $transaction: jest.fn(async (callback, options) => {
        expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        return callback(tx);
      }),
    };
    audit = { record: jest.fn(async () => undefined) };
    service = new PlatformSubscriptionService(prisma, tenants, plans as any, audit as any);
  });

  describe('changePlan', () => {
    const change = (dto: Record<string, unknown>) =>
      service.changePlan(TENANT, { reason: 'Acuerdo comercial', ...dto } as any, ACTOR);

    it('puts the clinic on the plan and keeps a running paid period', async () => {
      await change({ planId: pro.id });

      expect(plans.findAssignable).toHaveBeenCalledWith(tx, pro.id, 'CLINIC');
      expect(plans.assign).toHaveBeenCalledWith(tx, TENANT, pro);
      expect(updates).toEqual([{ status: 'ACTIVE' }]);
      expect(events).toEqual([
        expect.objectContaining({
          eventType: 'PLAN_UPGRADED',
          previousPlan: 'CLINIC_BASIC',
          newPlan: 'CLINIC_PRO',
          reason: 'Acuerdo comercial',
          triggeredByUserId: ACTOR,
        }),
      ]);
    });

    it('records a cheaper plan as a downgrade and the overrides it dropped', async () => {
      subscription = {
        ...subscription,
        planId: pro.id,
        plan: pro,
        overriddenFields: ['basePrice'],
      };

      await change({ planId: basic.id });

      expect(events[0]).toMatchObject({
        eventType: 'PLAN_DOWNGRADED',
        metadata: expect.objectContaining({ droppedOverrides: ['basePrice'] }),
      });
    });

    it('starts a paid month today when no paid period is running', async () => {
      subscription = { ...subscription, status: 'TRIALING', currentPeriodEnd: null };

      await change({ planId: pro.id });

      expect(updates[0]).toMatchObject({
        status: 'ACTIVE',
        trialEndsAt: null,
        currentPeriodStart: expect.any(Date),
        currentPeriodEnd: expect.any(Date),
      });
      const { currentPeriodStart, currentPeriodEnd } = updates[0];
      expect(currentPeriodEnd.getTime()).toBeGreaterThan(currentPeriodStart.getTime());
    });

    it('starts a trial on the plan when trial days are given, also on the same plan', async () => {
      await change({ planId: basic.id, trialDays: 30 });

      expect(updates[0]).toMatchObject({ status: 'TRIALING', currentPeriodEnd: null });
      const days = (updates[0].trialEndsAt - updates[0].currentPeriodStart) / 86_400_000;
      expect(Math.round(days)).toBe(30);
      expect(events[0]).toMatchObject({
        eventType: 'SUBSCRIPTION_ACTIVATED',
        newStatus: 'TRIALING',
      });
    });

    it('answers PLAN_UNCHANGED and writes nothing for the plan the clinic already has', async () => {
      await expect(change({ planId: basic.id })).rejects.toMatchObject({
        status: 400,
        response: { code: 'PLAN_UNCHANGED' },
      });
      expect(plans.assign).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it('lowers limits below current usage without blocking: nothing is deleted', async () => {
      subscription = { ...subscription, activePatientsCount: 400 };
      const small = { ...basic, id: 'plan_small', code: 'SMALL', maxActivePatients: 100 };
      plans.findAssignable.mockResolvedValueOnce(small);

      await change({ planId: small.id });

      expect(plans.assign).toHaveBeenCalledWith(tx, TENANT, small);
    });

    it('lets the plan service refuse an archived or mismatched plan', async () => {
      plans.findAssignable.mockRejectedValueOnce(
        Object.assign(new Error('archived'), { status: 409 }),
      );

      await expect(change({ planId: 'plan_old' })).rejects.toMatchObject({ status: 409 });
      expect(plans.assign).not.toHaveBeenCalled();
    });

    it('answers 404 for a missing tenant before changing anything', async () => {
      tenants.findOne.mockRejectedValueOnce(Object.assign(new Error('missing'), { status: 404 }));

      await expect(change({ planId: pro.id })).rejects.toMatchObject({ status: 404 });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('setOverrides', () => {
    const set = (dto: Record<string, unknown>) =>
      service.setOverrides(TENANT, { reason: 'Acuerdo', values: {}, ...dto } as any, ACTOR);

    it('sets values apart from the plan and remembers them as overrides', async () => {
      await set({ values: { basePrice: 79.5, maxActivePatients: 300 } });

      expect(updates).toHaveLength(1);
      expect(Number(updates[0].basePrice)).toBe(79.5);
      expect(updates[0].maxActivePatients).toBe(300);
      expect(updates[0].overriddenFields).toEqual(['basePrice', 'maxActivePatients']);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          actorId: ACTOR,
          entity: 'TENANT',
          reason: 'Acuerdo',
          changes: {
            before: { basePrice: 99, maxActivePatients: 150 },
            after: { basePrice: 79.5, maxActivePatients: 300 },
          },
        }),
        tx,
      );
    });

    it('puts a reset value back on the plan and forgets the override', async () => {
      subscription = {
        ...subscription,
        maxActivePatients: 300,
        storageGB: 40,
        overriddenFields: ['maxActivePatients', 'storageGB'],
      };

      await set({ reset: ['maxActivePatients'] });

      expect(updates[0].maxActivePatients).toBe(150);
      expect(updates[0]).not.toHaveProperty('storageGB');
      expect(updates[0].overriddenFields).toEqual(['storageGB']);
    });

    it.each([
      [{ status: 'ACTIVE' }, 'status'],
      [{ basePrice: -1 }, 'basePrice'],
      [{ basePrice: 10.555 }, 'basePrice'],
      [{ maxActivePatients: 2.5 }, 'maxActivePatients'],
      [{ seatsPsychologistsMax: 0 }, 'seatsPsychologistsMax'],
      [{ currency: 'dollars' }, 'currency'],
    ])('rejects %p with OVERRIDE_INVALID', async (values, field) => {
      await expect(set({ values })).rejects.toMatchObject({
        status: 400,
        response: { code: 'OVERRIDE_INVALID', field },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a value set and reset at once, and an empty request', async () => {
      await expect(set({ values: { storageGB: 5 }, reset: ['storageGB'] })).rejects.toMatchObject({
        response: { code: 'OVERRIDE_CONFLICT' },
      });
      await expect(set({})).rejects.toMatchObject({ response: { code: 'OVERRIDE_EMPTY' } });
      expect(updates).toEqual([]);
    });
  });
});
