import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PermissionChecker } from '../common/permissions/permission-checker.service';
import { StockAllocationService } from '../inventory/stock-allocation.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeOrderTotals } from './order-totals';
import { toOrderView } from './order-view';
import { OrdersService } from './orders.service';

const D = (value: string) => new Prisma.Decimal(value);

describe('OrdersService', () => {
  const prisma = {
    branchEmissionPoint: { findFirst: jest.fn() },
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    auditLog: { create: jest.fn() },
    branch: { findFirst: jest.fn() },
    patient: { findFirst: jest.fn() },
    specialtyRecord: { count: jest.fn() },
    patientFile: { count: jest.fn() },
    treatmentVersion: { findUnique: jest.fn() },
    consentDocument: { findMany: jest.fn() },
    billingProfile: { findFirst: jest.fn(), upsert: jest.fn() },
    patientBillingProfile: { findFirst: jest.fn(), upsert: jest.fn() },
    treatmentSession: { findMany: jest.fn(), findFirst: jest.fn() },
    order: {
      aggregate: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    orderItem: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    product: { findFirst: jest.fn() },
    tenantModule: { findMany: jest.fn() },
    tenantSettings: { findUnique: jest.fn() },
  };
  const permissionChecker = { assertAllowed: jest.fn() };
  const stockAllocation = { reserve: jest.fn(), release: jest.fn() };
  const service = new OrdersService(
    prisma as unknown as PrismaService,
    permissionChecker as unknown as PermissionChecker,
    stockAllocation as unknown as StockAllocationService,
  );

  const actor: AuthUser = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    email: 'a@b.c',
    role: 'ASISTENTE',
    isPlatformTenant: false,
    mustChangePassword: false,
  };

  const person = (id: string) => ({ id, firstName: 'Ana', lastName: 'Paz' });

  const patientBillingData = (extra: Record<string, unknown> = {}) => ({
    ...person('patient-1'),
    identificationType: 'CEDULA',
    identificationNumber: '1710034065',
    email: 'ana@example.com',
    phone: '0991234567',
    address: 'Quito',
    billingName: null,
    billingTaxIdType: null,
    billingTaxId: null,
    billingEmail: null,
    billingAddress: null,
    ...extra,
  });

  const item = (extra: Record<string, unknown> = {}) => ({
    id: 'item-1',
    tenantId: 'tenant-1',
    orderId: 'order-1',
    kind: 'TREATMENT_SESSION',
    treatmentSessionId: 'session-1',
    productId: null,
    patientId: 'patient-1',
    patient: person('patient-1'),
    description: 'Botox',
    quantity: D('1'),
    unitPrice: D('100'),
    discount: D('0'),
    taxRatePercent: D('15'),
    lineSubtotal: D('100'),
    lineTax: D('15'),
    releasedAt: null,
    createdAt: new Date('2026-10-15T10:00:00Z'),
    ...extra,
  });

  const order = (extra: Record<string, unknown> = {}) => ({
    id: 'order-1',
    tenantId: 'tenant-1',
    number: 7,
    status: 'OPEN',
    branchId: 'branch-1',
    billingProfileId: null,
    billingProfile: null,
    subtotal: D('100'),
    discountTotal: D('0'),
    taxTotal: D('15'),
    total: D('115'),
    paidTotal: D('0'),
    version: 3,
    createdAt: new Date('2026-10-15T10:00:00Z'),
    items: [item()],
    payments: [],
    ...extra,
  });

  const payment = (extra: Record<string, unknown> = {}) => ({
    id: 'payment-1',
    method: 'CASH',
    amount: D('115'),
    reference: null,
    status: 'RECORDED',
    receivedAt: new Date('2026-10-15T11:00:00Z'),
    receivedBy: person('user-1'),
    refundedAt: null,
    refundReason: null,
    ...extra,
  });

  const session = (extra: Record<string, unknown> = {}) => ({
    id: 'session-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    branchId: 'branch-1',
    status: 'CLINICAL_COMPLETE',
    treatmentVersion: {
      price: D('100'),
      taxRatePercent: D('15'),
      treatment: { name: 'Botox' },
    },
    orderItems: [],
    ...extra,
  });

  const rejection = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: { getResponse: () => { code: string } }) => error.getResponse().code,
    );

  const lastTotals = () => prisma.order.update.mock.calls.at(-1)![0].data;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
      callback(prisma),
    );
    prisma.branch.findFirst.mockResolvedValue({ id: 'branch-1' });
    prisma.order.aggregate.mockResolvedValue({ _max: { number: 4 } });
    prisma.order.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'order-1', ...data }),
    );
    prisma.order.update.mockResolvedValue({});
    prisma.orderItem.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'item-new', ...data }),
    );
    prisma.patientBillingProfile.findFirst.mockResolvedValue(null);
    prisma.patient.findFirst.mockResolvedValue(null);
    prisma.billingProfile.findFirst.mockResolvedValue({ id: 'profile-1', isActive: true });
    prisma.billingProfile.upsert.mockImplementation(
      ({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ id: 'patient-profile', isActive: true, ...create }),
    );
    prisma.order.findFirst.mockResolvedValue(order());
  });

  describe('create', () => {
    it('numbers the order after the last one of the tenant and has no automatic recipient for sessions of two patients', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([
        session(),
        session({ id: 'session-2', patientId: 'patient-2' }),
      ]);

      await service.create('tenant-1', actor, {
        treatmentSessionIds: ['session-1', 'session-2'],
      });

      expect(prisma.order.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        number: 5,
        branchId: 'branch-1',
        billingProfileId: null,
        createdById: 'user-1',
      });
      expect(prisma.patientBillingProfile.findFirst).not.toHaveBeenCalled();
      expect(prisma.orderItem.create).toHaveBeenCalledTimes(2);
      expect(prisma.orderItem.create.mock.calls[0][0].data).toMatchObject({
        kind: 'TREATMENT_SESSION',
        treatmentSessionId: 'session-1',
        patientId: 'patient-1',
        description: 'Botox',
        unitPrice: D('100'),
        taxRatePercent: D('15'),
        discount: D('0'),
        createdById: 'user-1',
      });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'CREATE',
        entity: 'ORDER',
        entityId: 'order-1',
      });
    });

    it('takes the default active billing profile of the only patient', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([session()]);
      prisma.patientBillingProfile.findFirst.mockResolvedValue({ billingProfileId: 'profile-9' });

      await service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] });

      expect(prisma.patientBillingProfile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: 'tenant-1',
            patientId: 'patient-1',
            isDefault: true,
            billingProfile: { isActive: true },
          },
        }),
      );
      expect(prisma.order.create.mock.calls[0][0].data.billingProfileId).toBe('profile-9');
      expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    });

    it('uses the registered patient identity and contact data without requiring a separate billing profile', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([session()]);
      prisma.patient.findFirst.mockResolvedValue(
        patientBillingData({
          identificationNumber: '171-0034065',
          firstName: ' Ana ',
          lastName: ' Paz ',
          email: ' ana@example.com ',
        }),
      );
      prisma.billingProfile.findFirst.mockResolvedValue(null);

      await service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] });

      expect(prisma.patient.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'patient-1', tenantId: 'tenant-1', deletedAt: null },
        }),
      );
      expect(prisma.billingProfile.upsert).toHaveBeenCalledWith({
        where: {
          tenantId_idType_idNumber: { tenantId: 'tenant-1', idType: '05', idNumber: '1710034065' },
        },
        update: {},
        create: {
          tenantId: 'tenant-1',
          kind: 'PERSON',
          idType: '05',
          idNumber: '1710034065',
          legalName: 'Ana Paz',
          email: 'ana@example.com',
          phone: '0991234567',
          address: 'Quito',
          createdById: 'user-1',
        },
      });
      expect(prisma.patientBillingProfile.upsert).toHaveBeenCalledWith({
        where: {
          patientId_billingProfileId: {
            patientId: 'patient-1',
            billingProfileId: 'patient-profile',
          },
        },
        update: {},
        create: {
          tenantId: 'tenant-1',
          patientId: 'patient-1',
          billingProfileId: 'patient-profile',
        },
      });
      expect(prisma.order.create.mock.calls[0][0].data.billingProfileId).toBe('patient-profile');
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'CREATE',
            entity: 'BILLING_PROFILE',
            entityId: 'patient-profile',
          }),
        }),
      );
    });

    it.each([
      ['RUC', '1710034065001', '04', 'PERSON'],
      ['RUC', '1790016919001', '04', 'COMPANY'],
      ['PASSPORT', 'ab-1234', '06', 'PERSON'],
    ])(
      'maps a registered %s identification %s to its billing type',
      async (identificationType, identificationNumber, idType, kind) => {
        prisma.treatmentSession.findMany.mockResolvedValue([session()]);
        prisma.patient.findFirst.mockResolvedValue(
          patientBillingData({ identificationType, identificationNumber }),
        );
        prisma.billingProfile.findFirst.mockResolvedValue(null);

        await service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] });

        expect(prisma.billingProfile.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({
              idType,
              kind,
              idNumber: identificationNumber.replace(/-/g, '').toUpperCase(),
            }),
          }),
        );
        expect(prisma.order.create.mock.calls[0][0].data.billingProfileId).toBe('patient-profile');
      },
    );

    it('preserves separately registered fiscal recipient data', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([session()]);
      prisma.patient.findFirst.mockResolvedValue(
        patientBillingData({
          billingName: 'Empresa cliente',
          billingTaxIdType: 'RUC',
          billingTaxId: '1790016919001',
          billingEmail: 'facturas@example.com',
          billingAddress: 'Cuenca',
        }),
      );
      prisma.billingProfile.findFirst.mockResolvedValue(null);

      await service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] });

      expect(prisma.billingProfile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            kind: 'COMPANY',
            idType: '04',
            idNumber: '1790016919001',
            legalName: 'Empresa cliente',
            email: 'facturas@example.com',
            address: 'Cuenca',
          }),
        }),
      );
    });

    it('reuses an active profile with the same identification without overwriting its data', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([session()]);
      prisma.patient.findFirst.mockResolvedValue(patientBillingData());
      prisma.billingProfile.findFirst.mockResolvedValue({ id: 'existing-profile', isActive: true });

      await service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] });

      expect(prisma.billingProfile.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', idType: '05', idNumber: '1710034065' },
      });
      expect(prisma.billingProfile.upsert).not.toHaveBeenCalled();
      expect(prisma.order.create.mock.calls[0][0].data.billingProfileId).toBe('existing-profile');
      expect(prisma.patientBillingProfile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ billingProfileId: 'existing-profile' }),
        }),
      );
    });

    it.each([
      { email: null },
      { email: 'invalid' },
      { identificationNumber: null },
      { identificationType: 'OTHER' },
      { identificationNumber: '1710034066' },
      { firstName: ' ', lastName: ' ' },
      { billingTaxId: '1790016919001', billingTaxIdType: 'RUC', billingName: null },
    ])(
      'keeps manual recipient selection available when registered data is incomplete or invalid: %j',
      async (extra) => {
        prisma.treatmentSession.findMany.mockResolvedValue([session()]);
        prisma.patient.findFirst.mockResolvedValue(patientBillingData(extra));
        prisma.billingProfile.findFirst.mockResolvedValue(null);

        await service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] });

        expect(prisma.order.create.mock.calls[0][0].data.billingProfileId).toBeNull();
        expect(prisma.billingProfile.upsert).not.toHaveBeenCalled();
        expect(prisma.patientBillingProfile.upsert).not.toHaveBeenCalled();
      },
    );

    it('does not reactivate an inactive profile automatically', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([session()]);
      prisma.patient.findFirst.mockResolvedValue(patientBillingData());
      prisma.billingProfile.findFirst.mockResolvedValue({
        id: 'inactive-profile',
        isActive: false,
      });

      await service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] });

      expect(prisma.order.create.mock.calls[0][0].data.billingProfileId).toBeNull();
      expect(prisma.billingProfile.upsert).not.toHaveBeenCalled();
      expect(prisma.patientBillingProfile.upsert).not.toHaveBeenCalled();
    });

    it('respects another recipient explicitly chosen for the order', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([session()]);
      prisma.patient.findFirst.mockResolvedValue(patientBillingData());
      prisma.billingProfile.findFirst.mockResolvedValue({ id: 'chosen-profile', isActive: true });

      await service.create('tenant-1', actor, {
        treatmentSessionIds: ['session-1'],
        billingProfileId: 'chosen-profile',
      });

      expect(prisma.order.create.mock.calls[0][0].data.billingProfileId).toBe('chosen-profile');
      expect(prisma.patient.findFirst).not.toHaveBeenCalled();
      expect(prisma.patientBillingProfile.findFirst).not.toHaveBeenCalled();
      expect(prisma.billingProfile.upsert).not.toHaveBeenCalled();
    });

    it('rejects sessions of different branches', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([
        session(),
        session({ id: 'session-2', branchId: 'branch-2' }),
      ]);

      expect(
        await rejection(
          service.create('tenant-1', actor, { treatmentSessionIds: ['session-1', 'session-2'] }),
        ),
      ).toBe('ORDER_BRANCH_MISMATCH');
    });

    it('rejects a session that cannot be billed', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([session({ status: 'NO_SHOW' })]);

      expect(
        await rejection(service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] })),
      ).toBe('TREATMENT_SESSION_NOT_BILLABLE');
    });

    it('rejects a session already in a live order', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([
        session({ orderItems: [{ id: 'item-x' }] }),
      ]);

      expect(
        await rejection(service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] })),
      ).toBe('SESSION_ALREADY_IN_ORDER');
    });

    it('rejects a session of another tenant', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([]);

      expect(
        await rejection(service.create('tenant-1', actor, { treatmentSessionIds: ['session-1'] })),
      ).toBe('TREATMENT_SESSION_NOT_FOUND');
    });

    it('requires a branch when there are no sessions', async () => {
      expect(await rejection(service.create('tenant-1', actor, {}))).toBe('ORDER_BRANCH_REQUIRED');
    });
  });

  describe('addItem', () => {
    const sessionDto = { version: 3, kind: 'TREATMENT_SESSION' as const };

    it('adds a session item copying the price and tax of its treatment version', async () => {
      prisma.treatmentSession.findFirst.mockResolvedValue(session({ id: 'session-2' }));

      await service.addItem('tenant-1', actor, 'order-1', {
        ...sessionDto,
        treatmentSessionId: 'session-2',
      });

      expect(permissionChecker.assertAllowed).not.toHaveBeenCalled();
      expect(prisma.orderItem.create.mock.calls[0][0].data).toMatchObject({
        orderId: 'order-1',
        treatmentSessionId: 'session-2',
        quantity: D('1'),
        unitPrice: D('100'),
        taxRatePercent: D('15'),
      });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'UPDATE',
        entity: 'ORDER',
      });
    });

    it('rejects a session already in another live order and translates the unique index', async () => {
      prisma.treatmentSession.findFirst.mockResolvedValue(
        session({ orderItems: [{ id: 'item-x' }] }),
      );
      expect(
        await rejection(
          service.addItem('tenant-1', actor, 'order-1', {
            ...sessionDto,
            treatmentSessionId: 'session-1',
          }),
        ),
      ).toBe('SESSION_ALREADY_IN_ORDER');

      prisma.treatmentSession.findFirst.mockResolvedValue(session());
      prisma.orderItem.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: 'OrderItem_live_session_key' },
        }),
      );
      expect(
        await rejection(
          service.addItem('tenant-1', actor, 'order-1', {
            ...sessionDto,
            treatmentSessionId: 'session-1',
          }),
        ),
      ).toBe('SESSION_ALREADY_IN_ORDER');
    });

    it('lets a session go into a new order after the other one was cancelled', async () => {
      // The cancelled order released its items, so the live-item filter finds nothing.
      prisma.treatmentSession.findFirst.mockResolvedValue(session({ orderItems: [] }));

      await service.addItem('tenant-1', actor, 'order-1', {
        ...sessionDto,
        treatmentSessionId: 'session-1',
      });

      expect(prisma.treatmentSession.findFirst.mock.calls[0][0].include.orderItems.where).toEqual({
        releasedAt: null,
      });
      expect(prisma.orderItem.create).toHaveBeenCalled();
    });

    it('requires billing.adjust for a free item', async () => {
      permissionChecker.assertAllowed.mockRejectedValue(
        new ForbiddenException({ statusCode: 403, code: 'PERMISSION_DENIED' }),
      );

      expect(
        await rejection(
          service.addItem('tenant-1', actor, 'order-1', {
            version: 3,
            kind: 'FREE',
            description: 'Gel',
            unitPrice: '10.00',
            taxRatePercent: 15,
          }),
        ),
      ).toBe('PERMISSION_DENIED');
      expect(permissionChecker.assertAllowed).toHaveBeenCalledWith(actor, 'billing.adjust');
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it('rejects a tax rate the server does not support', async () => {
      expect(
        await rejection(
          service.addItem('tenant-1', actor, 'order-1', {
            version: 3,
            kind: 'FREE',
            description: 'Gel',
            unitPrice: '10.00',
            taxRatePercent: 12,
          }),
        ),
      ).toBe('TAX_RATE_UNSUPPORTED');
    });

    it('requires billing.adjust for a discount on a session item', async () => {
      prisma.treatmentSession.findFirst.mockResolvedValue(session());

      await service.addItem('tenant-1', actor, 'order-1', {
        ...sessionDto,
        treatmentSessionId: 'session-1',
        discount: '10.00',
      });

      expect(permissionChecker.assertAllowed).toHaveBeenCalledWith(actor, 'billing.adjust');
    });

    it('stores totals equal to computeOrderTotals of every line', async () => {
      await service.addItem('tenant-1', actor, 'order-1', {
        version: 3,
        kind: 'FREE',
        description: 'Gel',
        quantity: '3',
        unitPrice: '3.33',
        taxRatePercent: 5,
        discount: '1.00',
      });

      const expected = computeOrderTotals([
        { quantity: '1', unitPrice: '100', discount: '0', taxRatePercent: '15' },
        { quantity: '3', unitPrice: '3.33', discount: '1.00', taxRatePercent: '5' },
      ]);
      const data = lastTotals();
      expect(data.subtotal).toEqual(expected.subtotal);
      expect(data.discountTotal).toEqual(expected.discountTotal);
      expect(data.taxTotal).toEqual(expected.taxTotal);
      expect(data.total).toEqual(expected.total);
      expect(data.version).toEqual({ increment: 1 });
      expect(data).not.toHaveProperty('paidTotal');
      expect(data).not.toHaveProperty('status');
    });

    it('refuses to edit an order that has a recorded payment', async () => {
      prisma.order.findFirst.mockResolvedValue(order({ payments: [payment()] }));

      expect(
        await rejection(
          service.addItem('tenant-1', actor, 'order-1', {
            ...sessionDto,
            treatmentSessionId: 'session-2',
          }),
        ),
      ).toBe('ORDER_NOT_EDITABLE');
    });

    it('rejects a stale version', async () => {
      expect(
        await rejection(
          service.addItem('tenant-1', actor, 'order-1', {
            version: 2,
            kind: 'TREATMENT_SESSION',
            treatmentSessionId: 'session-2',
          }),
        ),
      ).toBe('ORDER_VERSION_CONFLICT');
    });

    it('reports a missing order', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      expect(
        await rejection(
          service.addItem('tenant-1', actor, 'order-1', {
            version: 3,
            kind: 'TREATMENT_SESSION',
            treatmentSessionId: 'session-2',
          }),
        ),
      ).toBe('ORDER_NOT_FOUND');
    });
  });

  describe('addItem of a product', () => {
    const productDto = {
      version: 3,
      kind: 'PRODUCT' as const,
      productId: 'product-1',
      quantity: '2',
    };

    const product = (extra: Record<string, unknown> = {}) => ({
      id: 'product-1',
      name: 'Protector solar',
      price: D('20'),
      taxRatePercent: D('15'),
      isActive: true,
      ...extra,
    });

    beforeEach(() => {
      prisma.tenantModule.findMany.mockResolvedValue([
        { moduleKey: 'core.billing' },
        { moduleKey: 'core.billing.inventory' },
      ]);
      prisma.tenantSettings.findUnique.mockResolvedValue({ timezone: 'America/Guayaquil' });
      prisma.product.findFirst.mockResolvedValue(product());
    });

    it('does not need billing.adjust without a discount', async () => {
      await service.addItem('tenant-1', actor, 'order-1', productDto);

      expect(permissionChecker.assertAllowed).not.toHaveBeenCalled();
    });

    it('needs billing.adjust for a discount', async () => {
      await service.addItem('tenant-1', actor, 'order-1', { ...productDto, discount: '5.00' });

      expect(permissionChecker.assertAllowed).toHaveBeenCalledWith(actor, 'billing.adjust');
    });

    it.each(['2.5', '0', '-1'])(
      'rejects the quantity %s before writing or reserving',
      async (quantity) => {
        expect(
          await rejection(
            service.addItem('tenant-1', actor, 'order-1', { ...productDto, quantity }),
          ),
        ).toBe('ORDER_LINE_INVALID');
        expect(prisma.orderItem.create).not.toHaveBeenCalled();
        expect(stockAllocation.reserve).not.toHaveBeenCalled();
      },
    );

    it('rejects an inactive product', async () => {
      prisma.product.findFirst.mockResolvedValue(product({ isActive: false }));

      expect(await rejection(service.addItem('tenant-1', actor, 'order-1', productDto))).toBe(
        'PRODUCT_INACTIVE',
      );
      expect(stockAllocation.reserve).not.toHaveBeenCalled();
    });

    it('does not find a product of another tenant', async () => {
      prisma.product.findFirst.mockResolvedValue(null);

      expect(await rejection(service.addItem('tenant-1', actor, 'order-1', productDto))).toBe(
        'PRODUCT_NOT_FOUND',
      );
      expect(prisma.product.findFirst.mock.calls[0][0].where).toEqual({
        id: 'product-1',
        tenantId: 'tenant-1',
      });
    });

    it('answers SECTION_NOT_ENABLED when the inventory section is off', async () => {
      prisma.tenantModule.findMany.mockResolvedValue([{ moduleKey: 'core.billing' }]);

      expect(await rejection(service.addItem('tenant-1', actor, 'order-1', productDto))).toBe(
        'SECTION_NOT_ENABLED',
      );
      expect(prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it('creates the line with the price, tax and name of the product and reserves its stock', async () => {
      await service.addItem('tenant-1', actor, 'order-1', productDto);

      expect(prisma.orderItem.create.mock.calls[0][0].data).toMatchObject({
        orderId: 'order-1',
        kind: 'PRODUCT',
        productId: 'product-1',
        treatmentSessionId: null,
        patientId: null,
        description: 'Protector solar',
        quantity: D('2'),
        unitPrice: D('20'),
        taxRatePercent: D('15'),
        discount: D('0'),
      });
      expect(stockAllocation.reserve).toHaveBeenCalledWith(prisma, {
        tenantId: 'tenant-1',
        actorId: 'user-1',
        orderItemId: 'item-new',
        productId: 'product-1',
        branchId: 'branch-1',
        quantity: 2,
        today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      });
      expect(prisma.auditLog.create.mock.calls[0][0].data.changes.addedItem).toMatchObject({
        id: 'item-new',
        kind: 'PRODUCT',
        productId: 'product-1',
      });
    });
  });

  describe('removeItem and updateItemDiscount', () => {
    it('removes an item and recalculates', async () => {
      await service.removeItem('tenant-1', 'user-1', 'order-1', 'item-1', 3);

      expect(prisma.orderItem.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
      expect(lastTotals().total).toEqual(D('0'));
      expect(stockAllocation.release).not.toHaveBeenCalled();
    });

    it('returns the stock of a product line before deleting it', async () => {
      prisma.order.findFirst.mockResolvedValue(
        order({
          items: [
            item(),
            item({
              id: 'item-2',
              kind: 'PRODUCT',
              treatmentSessionId: null,
              productId: 'product-1',
            }),
          ],
        }),
      );

      await service.removeItem('tenant-1', 'user-1', 'order-1', 'item-2', 3);

      expect(stockAllocation.release).toHaveBeenCalledWith(prisma, {
        tenantId: 'tenant-1',
        actorId: 'user-1',
        orderItemIds: ['item-2'],
      });
      expect(prisma.orderItem.delete).toHaveBeenCalledWith({ where: { id: 'item-2' } });
      expect(stockAllocation.release.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.orderItem.delete.mock.invocationCallOrder[0],
      );
    });

    it('changes the discount of an item', async () => {
      await service.updateItemDiscount('tenant-1', 'user-1', 'order-1', 'item-1', {
        version: 3,
        discount: '10.00',
      });

      expect(lastTotals().discountTotal).toEqual(D('10'));
    });

    it('does not find an item of another order', async () => {
      expect(
        await rejection(service.removeItem('tenant-1', 'user-1', 'order-1', 'item-zzz', 3)),
      ).toBe('ORDER_ITEM_NOT_FOUND');
    });
  });

  describe('setBillingProfile', () => {
    it('sets an active profile of the tenant on an open or paid order', async () => {
      prisma.order.findFirst.mockResolvedValue(order({ status: 'PAID' }));

      await service.setBillingProfile('tenant-1', 'user-1', 'order-1', {
        version: 3,
        billingProfileId: 'profile-1',
      });

      expect(prisma.order.update.mock.calls[0][0].data).toMatchObject({
        billingProfileId: 'profile-1',
      });
    });

    it('rejects an inactive profile', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue({ id: 'profile-1', isActive: false });

      expect(
        await rejection(
          service.setBillingProfile('tenant-1', 'user-1', 'order-1', {
            version: 3,
            billingProfileId: 'profile-1',
          }),
        ),
      ).toBe('BILLING_PROFILE_INACTIVE');
    });
  });

  describe('cancel', () => {
    it('cancels the order and releases its sessions', async () => {
      await service.cancel('tenant-1', 'user-1', 'order-1', { version: 3, reason: 'Error' });

      expect(prisma.order.update.mock.calls[0][0].data).toMatchObject({
        status: 'CANCELLED',
        cancelledById: 'user-1',
        cancellationReason: 'Error',
      });
      expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'order-1', releasedAt: null },
        data: { releasedAt: expect.any(Date) },
      });
      expect(stockAllocation.release).not.toHaveBeenCalled();
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'UPDATE',
        entity: 'ORDER',
        reason: 'Error',
      });
    });

    it('returns the stock of its unreleased product lines before releasing every item', async () => {
      const productItem = (id: string) =>
        item({ id, kind: 'PRODUCT', treatmentSessionId: null, productId: 'product-1' });
      prisma.order.findFirst.mockResolvedValue(
        order({ items: [item(), productItem('item-2'), productItem('item-3')] }),
      );

      await service.cancel('tenant-1', 'user-1', 'order-1', { version: 3, reason: 'Error' });

      expect(stockAllocation.release).toHaveBeenCalledTimes(1);
      expect(stockAllocation.release).toHaveBeenCalledWith(prisma, {
        tenantId: 'tenant-1',
        actorId: 'user-1',
        orderItemIds: ['item-2', 'item-3'],
      });
      expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'order-1', releasedAt: null },
        data: { releasedAt: expect.any(Date) },
      });
      expect(stockAllocation.release.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.orderItem.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('refuses to cancel an order with a recorded payment', async () => {
      prisma.order.findFirst.mockResolvedValue(order({ payments: [payment()] }));

      expect(
        await rejection(
          service.cancel('tenant-1', 'user-1', 'order-1', { version: 3, reason: 'Error' }),
        ),
      ).toBe('ORDER_HAS_PAYMENTS');
    });
  });

  describe('toOrderView', () => {
    it('exposes nothing of the session but its id', () => {
      const view = toOrderView(
        order({
          payments: [payment()],
          items: [item({ treatmentSession: { procedureNotes: 'secret' } })],
        }) as never,
      );

      expect(view.items[0].treatmentSessionId).toBe('session-1');
      expect(view.items[0].productId).toBeNull();
      expect(JSON.stringify(view)).not.toContain('secret');
      expect(view.balance).toBe('115.00');
      expect(view.total).toBe('115.00');
      expect(view.payments[0].amount).toBe('115.00');
    });
  });

  describe('list and get', () => {
    it('lists the orders of the tenant', async () => {
      prisma.order.findMany.mockResolvedValue([order()]);
      prisma.order.count.mockResolvedValue(1);

      const result = await service.list('tenant-1', { status: 'OPEN', q: '7' });

      expect(prisma.order.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: 'tenant-1',
        status: 'OPEN',
      });
      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(result.items[0].number).toBe(7);
    });

    it('404s an order of another tenant', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      expect(await rejection(service.get('tenant-1', 'order-1'))).toBe('ORDER_NOT_FOUND');
    });
  });

  describe('billing eligibility and billable sessions', () => {
    const fullSession = (extra: Record<string, unknown> = {}) => ({
      id: 'session-1',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      branchId: 'branch-1',
      status: 'CLINICAL_COMPLETE',
      formRecordId: null,
      consentDocumentId: null,
      startedAt: new Date('2026-10-14T10:00:00Z'),
      completedAt: new Date('2026-10-14T11:00:00Z'),
      createdAt: new Date('2026-10-14T09:00:00Z'),
      treatmentVersionId: 'version-1',
      patient: {
        id: 'patient-1',
        firstName: 'Ana',
        lastName: 'Paz',
        identificationNumber: '0912345678',
      },
      treatmentVersion: {
        id: 'version-1',
        version: 2,
        consentTemplateVersionId: null,
        price: D('100'),
        taxRatePercent: D('15'),
        requirements: {},
        treatment: { id: 'treatment-1', name: 'Botox' },
      },
      ...extra,
    });

    const orderForEligibility = (extra: Record<string, unknown> = {}) => ({
      id: 'order-1',
      total: D('115'),
      paidTotal: D('115'),
      items: [item()],
      billingProfile: { isActive: true, idType: '05' },
      ...extra,
    });

    beforeEach(() => {
      prisma.branchEmissionPoint.findFirst.mockResolvedValue({ id: 'point' });
      prisma.patientFile.count.mockResolvedValue(0);
      prisma.specialtyRecord.count.mockResolvedValue(0);
    });

    it('flags a paid order whose session was cancelled', async () => {
      prisma.order.findFirst.mockResolvedValue(orderForEligibility());
      prisma.treatmentSession.findMany.mockResolvedValue([fullSession({ status: 'CANCELLED' })]);

      const result = await service.eligibility('tenant-1', 'order-1');

      expect(result.eligible).toBe(false);
      expect(result.missing).toContain('SESSION_NOT_BILLABLE');
      expect(result.items[0].codes).toEqual(['SESSION_NOT_BILLABLE']);
      expect(Object.keys(result).sort()).toEqual(['eligible', 'items', 'missing']);
    });

    it('asks for a receiver and the balance of an order without them', async () => {
      prisma.order.findFirst.mockResolvedValue(
        orderForEligibility({ paidTotal: D('0'), billingProfile: null }),
      );
      prisma.treatmentSession.findMany.mockResolvedValue([fullSession()]);

      const result = await service.eligibility('tenant-1', 'order-1');

      expect(result.missing).toEqual(['BILLING_PROFILE', 'BALANCE_DUE']);
      expect(result.items).toEqual([]);
    });

    it('404s an order of another tenant', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      expect(await rejection(service.eligibility('tenant-1', 'order-9'))).toBe('ORDER_NOT_FOUND');
    });

    it('lists only sessions with no live item and not in a non-billable status', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([fullSession()]);

      await service.billableSessions('tenant-1', { branchId: 'branch-1', patientId: 'patient-1' });

      const args = prisma.treatmentSession.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        orderItems: { none: { releasedAt: null } },
        OR: [{ branchId: 'branch-1' }, { branchId: null }],
      });
      expect(args.where.status.notIn).toEqual(
        expect.arrayContaining(['CANCELLED', 'NO_SHOW', 'BILLED', 'BILLING_PENDING']),
      );
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.take).toBe(100);
    });

    it('returns exactly the billable fields and marks a compliant session', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([fullSession()]);

      const [session] = await service.billableSessions('tenant-1', {});

      expect(Object.keys(session).sort()).toEqual(
        [
          'branchId',
          'compliant',
          'completedAt',
          'createdAt',
          'id',
          'patient',
          'price',
          'status',
          'taxRatePercent',
          'treatment',
        ].sort(),
      );
      expect(session).toMatchObject({
        compliant: true,
        price: '100.00',
        taxRatePercent: '15.00',
        treatment: { id: 'treatment-1', name: 'Botox', version: 2 },
        patient: { identificationNumber: '0912345678' },
      });
    });

    it('marks non compliant a session without the required form', async () => {
      prisma.treatmentSession.findMany.mockResolvedValue([
        fullSession({
          treatmentVersion: {
            ...fullSession().treatmentVersion,
            requirements: { medicalForm: { required: true } },
          },
        }),
      ]);

      const [session] = await service.billableSessions('tenant-1', {});

      expect(session.compliant).toBe(false);
    });
  });
});
