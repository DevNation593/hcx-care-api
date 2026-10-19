import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrderItem, Prisma } from '@prisma/client';
import { patientBillingProfileId } from '../billing-profiles/patient-billing-profile';
import { BillingEligibility, evaluateBillingEligibility } from './billing-eligibility';
import {
  BillableSession,
  loadOrderBillingFacts,
  loadSessionBillingFacts,
  NOT_BILLABLE_SESSION_STATUSES,
} from './eligibility-facts';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PermissionChecker } from '../common/permissions/permission-checker.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import {
  AddOrderItemDto,
  CancelOrderDto,
  CreateOrderDto,
  BillableSessionsQuery,
  ListOrdersQuery,
  SetOrderBillingProfileDto,
  UpdateOrderItemDto,
} from './dto/order.dto';
import { computeOrderTotals, SUPPORTED_FREE_TAX_RATES } from './order-totals';
import { orderInclude, OrderView, OrderWithRelations, toOrderView } from './order-view';

const DEFAULT_PAGE_SIZE = 20;
const BILLABLE_SESSIONS_LIMIT = 100;
const D = Prisma.Decimal;

const orderNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'ORDER_NOT_FOUND',
    message: 'Orden no encontrada.',
  });

const versionConflict = () =>
  new ConflictException({
    statusCode: 409,
    code: 'ORDER_VERSION_CONFLICT',
    message: 'La orden cambió mientras la editaba. Recargue e intente de nuevo.',
  });

const notEditable = () =>
  new ConflictException({
    statusCode: 409,
    code: 'ORDER_NOT_EDITABLE',
    message: 'La orden ya no se puede modificar.',
  });

const itemNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'ORDER_ITEM_NOT_FOUND',
    message: 'Ítem no encontrado en la orden.',
  });

const sessionNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'TREATMENT_SESSION_NOT_FOUND',
    message: 'Sesión de tratamiento no encontrada.',
  });

const sessionNotBillable = () =>
  new ConflictException({
    statusCode: 409,
    code: 'TREATMENT_SESSION_NOT_BILLABLE',
    message: 'La sesión no se puede facturar en esta orden.',
  });

const sessionAlreadyInOrder = () =>
  new ConflictException({
    statusCode: 409,
    code: 'SESSION_ALREADY_IN_ORDER',
    message: 'La sesión ya está en otra orden.',
  });

const branchMismatch = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'ORDER_BRANCH_MISMATCH',
    message: 'Las sesiones deben ser de la misma sucursal de la orden.',
  });

const branchRequired = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'ORDER_BRANCH_REQUIRED',
    message: 'Indique la sucursal de la orden.',
  });

const lineInvalid = (message: string) =>
  new UnprocessableEntityException({ statusCode: 422, code: 'ORDER_LINE_INVALID', message });

const taxRateUnsupported = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'TAX_RATE_UNSUPPORTED',
    message: `La tarifa de IVA debe ser una de: ${SUPPORTED_FREE_TAX_RATES.join(', ')}.`,
  });

const hasPayments = () =>
  new ConflictException({
    statusCode: 409,
    code: 'ORDER_HAS_PAYMENTS',
    message: 'La orden tiene pagos registrados: reembolse los pagos antes de anularla.',
  });

const branchNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'BRANCH_NOT_FOUND',
    message: 'Sucursal no encontrada.',
  });

const patientNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'PATIENT_NOT_FOUND',
    message: 'Paciente no encontrado.',
  });

const profileNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'BILLING_PROFILE_NOT_FOUND',
    message: 'Perfil de facturación no encontrado.',
  });

const profileInactive = () =>
  new ConflictException({
    statusCode: 409,
    code: 'BILLING_PROFILE_INACTIVE',
    message: 'El perfil de facturación está inactivo.',
  });

const isUniqueViolation = (error: unknown) =>
  (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';

type TotalsItem = Pick<
  OrderItem,
  'id' | 'quantity' | 'unitPrice' | 'discount' | 'taxRatePercent' | 'lineSubtotal' | 'lineTax'
>;

type LineData = Pick<
  Prisma.OrderItemUncheckedCreateInput,
  | 'kind'
  | 'treatmentSessionId'
  | 'patientId'
  | 'description'
  | 'quantity'
  | 'unitPrice'
  | 'discount'
  | 'taxRatePercent'
>;

const sessionInclude = {
  treatmentVersion: { include: { treatment: { select: { name: true } } } },
  // Items still holding the session; a cancelled order releases its items.
  orderItems: { where: { releasedAt: null }, select: { id: true } },
} satisfies Prisma.TreatmentSessionInclude;

type SessionToOrder = Prisma.TreatmentSessionGetPayload<{ include: typeof sessionInclude }>;

/** Loads the order for a write; 404 ORDER_NOT_FOUND, 409 ORDER_VERSION_CONFLICT on a stale version. */
export async function loadOrderForWrite(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
  version?: number,
): Promise<OrderWithRelations> {
  const order = await tx.order.findFirst({
    where: { id: orderId, tenantId },
    include: orderInclude,
  });
  if (!order) throw orderNotFound();
  if (version !== undefined && order.version !== version) throw versionConflict();
  return order;
}

/**
 * Recomputes every line and the totals of the order and increments its version. It does not
 * touch paidTotal or the OPEN/PAID status: the payments service owns them.
 */
export async function saveTotals(
  tx: Prisma.TransactionClient,
  order: { id: string; items: TotalsItem[] },
): Promise<void> {
  const totals = computeOrderTotals(order.items);
  for (const [index, item] of order.items.entries()) {
    const line = totals.lines[index];
    if (
      new D(item.lineSubtotal).equals(line.lineSubtotal) &&
      new D(item.lineTax).equals(line.lineTax)
    ) {
      continue;
    }
    await tx.orderItem.update({
      where: { id: item.id },
      data: { lineSubtotal: line.lineSubtotal, lineTax: line.lineTax },
    });
  }
  await tx.order.update({
    where: { id: order.id },
    data: {
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      version: { increment: 1 },
    },
  });
}

function assertEditable(order: OrderWithRelations): void {
  const paid = order.payments.some((payment) => payment.status === 'RECORDED');
  if (order.status !== 'OPEN' || paid) throw notEditable();
}

/** The line of a session item: price and tax of the treatment version the session was opened with. */
function sessionLine(session: SessionToOrder, discount: string): LineData {
  return {
    kind: 'TREATMENT_SESSION',
    treatmentSessionId: session.id,
    patientId: session.patientId,
    description: session.treatmentVersion.treatment.name,
    quantity: new D(1),
    unitPrice: session.treatmentVersion.price,
    discount: new D(discount),
    taxRatePercent: session.treatmentVersion.taxRatePercent,
  };
}

function assertBillable(session: SessionToOrder, orderBranchId: string): void {
  if (NOT_BILLABLE_SESSION_STATUSES.includes(session.status)) throw sessionNotBillable();
  if (session.branchId !== null && session.branchId !== orderBranchId) throw sessionNotBillable();
  if (session.orderItems.length > 0) throw sessionAlreadyInOrder();
}

async function createItem(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorId: string,
  orderId: string,
  line: LineData,
) {
  try {
    return await tx.orderItem.create({
      data: {
        ...line,
        tenantId,
        orderId,
        lineSubtotal: new D(0),
        lineTax: new D(0),
        createdById: actorId,
      },
    });
  } catch (error) {
    // The only unique index of the table is the one that keeps a session in one live order.
    if (isUniqueViolation(error)) throw sessionAlreadyInOrder();
    throw error;
  }
}

const itemSnapshot = (line: LineData) => ({
  kind: line.kind,
  treatmentSessionId: line.treatmentSessionId ?? null,
  description: line.description,
  quantity: new D(line.quantity as Prisma.Decimal.Value).toString(),
  unitPrice: new D(line.unitPrice as Prisma.Decimal.Value).toFixed(2),
  discount: new D(line.discount as Prisma.Decimal.Value).toFixed(2),
  taxRatePercent: new D(line.taxRatePercent as Prisma.Decimal.Value).toString(),
});

async function activeProfile(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const profile = await tx.billingProfile.findFirst({
    where: { id, tenantId },
    select: { id: true, isActive: true },
  });
  if (!profile) throw profileNotFound();
  if (!profile.isActive) throw profileInactive();
  return profile;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionChecker: PermissionChecker,
  ) {}

  async list(tenantId: string, query: ListOrdersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.OrderWhereInput = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.branchId ? { branchId: query.branchId } : {}),
    };
    if (query.q) {
      const text = { contains: query.q, mode: 'insensitive' as const };
      const number = /^\d{1,9}$/.test(query.q) ? Number(query.q) : null;
      where.OR = [
        ...(number === null ? [] : [{ number }]),
        { billingProfile: { legalName: text } },
        { billingProfile: { idNumber: { startsWith: query.q } } },
        { items: { some: { patient: { OR: [{ firstName: text }, { lastName: text }] } } } },
      ];
    }
    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: orderInclude,
        orderBy: { number: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items: orders.map(toOrderView), total, page, pageSize };
  }

  async get(tenantId: string, id: string): Promise<OrderView> {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: orderInclude,
    });
    if (!order) throw orderNotFound();
    return toOrderView(order);
  }

  /** RN-10 for an order, from the server-side facts of its sessions. */
  eligibility(tenantId: string, orderId: string, userId = ''): Promise<BillingEligibility> {
    return runSerializableTransaction(this.prisma, tenantId, userId, async (tx) =>
      evaluateBillingEligibility(await loadOrderBillingFacts(tx, tenantId, orderId, new Date())),
    );
  }

  /** Sessions without a live item that can still be invoiced, newest first. */
  billableSessions(
    tenantId: string,
    query: BillableSessionsQuery,
    userId = '',
  ): Promise<BillableSession[]> {
    return runSerializableTransaction(this.prisma, tenantId, userId, async (tx) => {
      const now = new Date();
      const sessions = await tx.treatmentSession.findMany({
        where: {
          tenantId,
          status: { notIn: NOT_BILLABLE_SESSION_STATUSES },
          orderItems: { none: { releasedAt: null } },
          ...(query.branchId ? { OR: [{ branchId: query.branchId }, { branchId: null }] } : {}),
          ...(query.patientId ? { patientId: query.patientId } : {}),
        },
        include: {
          treatmentVersion: { include: { treatment: { select: { id: true, name: true } } } },
          patient: {
            select: { id: true, firstName: true, lastName: true, identificationNumber: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: BILLABLE_SESSIONS_LIMIT,
      });

      const result: BillableSession[] = [];
      for (const session of sessions) {
        const facts = await loadSessionBillingFacts(tx, session, session.id, now);
        // The session alone: neutral cash facts so only its clinical codes can show up.
        const evaluation = evaluateBillingEligibility({
          sessions: [facts],
          itemCount: 1,
          total: new D(1),
          paidTotal: new D(1),
          profile: { isActive: true, idType: '05' },
          invoicingConfigured: null,
        });
        const { treatmentVersion, patient } = session;
        result.push({
          id: session.id,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          completedAt: session.completedAt ? session.completedAt.toISOString() : null,
          branchId: session.branchId,
          patient: {
            id: patient.id,
            firstName: patient.firstName,
            lastName: patient.lastName,
            identificationNumber: patient.identificationNumber,
          },
          treatment: {
            id: treatmentVersion.treatment.id,
            name: treatmentVersion.treatment.name,
            version: treatmentVersion.version,
          },
          price: new D(treatmentVersion.price).toFixed(2),
          taxRatePercent: new D(treatmentVersion.taxRatePercent).toFixed(2),
          compliant: evaluation.eligible,
        });
      }
      return result;
    });
  }

  create(tenantId: string, actor: AuthUser, dto: CreateOrderDto): Promise<OrderView> {
    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const ids = [...new Set(dto.treatmentSessionIds ?? [])];
      const sessions = ids.length
        ? await tx.treatmentSession.findMany({
            where: { id: { in: ids }, tenantId },
            include: sessionInclude,
          })
        : [];
      if (sessions.length !== ids.length) throw sessionNotFound();

      const sessionBranches = [
        ...new Set(sessions.flatMap((s) => (s.branchId ? [s.branchId] : []))),
      ];
      if (sessionBranches.length > 1) throw branchMismatch();
      if (dto.branchId && sessionBranches.length === 1 && dto.branchId !== sessionBranches[0]) {
        throw branchMismatch();
      }
      const branchId = dto.branchId ?? sessionBranches[0];
      if (!branchId) throw branchRequired();

      const branch = await tx.branch.findFirst({
        where: { id: branchId, tenantId, isActive: true },
        select: { id: true },
      });
      if (!branch) throw branchNotFound();

      for (const session of sessions) assertBillable(session, branchId);

      let billingProfileId: string | null = null;
      if (dto.billingProfileId) {
        billingProfileId = (await activeProfile(tx, tenantId, dto.billingProfileId)).id;
      } else {
        const patientIds = new Set(sessions.map((s) => s.patientId));
        if (patientIds.size === 1) {
          const link = await tx.patientBillingProfile.findFirst({
            where: {
              tenantId,
              patientId: [...patientIds][0],
              isDefault: true,
              billingProfile: { isActive: true },
            },
            select: { billingProfileId: true },
          });
          billingProfileId =
            link?.billingProfileId ??
            (await patientBillingProfileId(tx, tenantId, actor.userId, [...patientIds][0]));
        }
      }

      const last = await tx.order.aggregate({ where: { tenantId }, _max: { number: true } });
      const created = await tx.order.create({
        data: {
          tenantId,
          number: (last._max.number ?? 0) + 1,
          branchId,
          billingProfileId,
          createdById: actor.userId,
        },
      });

      const items: Awaited<ReturnType<typeof createItem>>[] = [];
      for (const session of sessions) {
        items.push(
          await createItem(tx, tenantId, actor.userId, created.id, sessionLine(session, '0')),
        );
      }
      await saveTotals(tx, { id: created.id, items });

      await recordBillingAudit(tx, {
        tenantId,
        actorId: actor.userId,
        action: 'CREATE',
        entity: 'ORDER',
        entityId: created.id,
        changes: {
          number: created.number,
          branchId,
          billingProfileId,
          treatmentSessionIds: sessions.map((s) => s.id),
        },
      });
      return this.view(tx, tenantId, created.id);
    });
  }

  async addItem(
    tenantId: string,
    actor: AuthUser,
    orderId: string,
    dto: AddOrderItemDto,
  ): Promise<OrderView> {
    const discount = dto.discount ?? '0';
    const hasDiscount = !new D(discount).isZero();
    if (dto.kind === 'FREE' || hasDiscount) {
      await this.permissionChecker.assertAllowed(actor, 'billing.adjust');
    }

    return runSerializableTransaction(this.prisma, tenantId, actor.userId, async (tx) => {
      const order = await loadOrderForWrite(tx, tenantId, orderId, dto.version);
      assertEditable(order);

      let line: LineData;
      if (dto.kind === 'TREATMENT_SESSION') {
        if (!dto.treatmentSessionId) throw lineInvalid('Indique la sesión de tratamiento.');
        const session = await tx.treatmentSession.findFirst({
          where: { id: dto.treatmentSessionId, tenantId },
          include: sessionInclude,
        });
        if (!session) throw sessionNotFound();
        assertBillable(session, order.branchId);
        line = sessionLine(session, discount);
      } else {
        if (!dto.description) throw lineInvalid('Indique la descripción del concepto.');
        if (dto.unitPrice === undefined) throw lineInvalid('Indique el precio unitario.');
        if (dto.taxRatePercent === undefined) throw lineInvalid('Indique la tarifa de IVA.');
        if (!SUPPORTED_FREE_TAX_RATES.includes(dto.taxRatePercent)) throw taxRateUnsupported();
        if (dto.patientId) {
          const patient = await tx.patient.findFirst({
            where: { id: dto.patientId, tenantId },
            select: { id: true },
          });
          if (!patient) throw patientNotFound();
        }
        line = {
          kind: 'FREE',
          treatmentSessionId: null,
          patientId: dto.patientId ?? null,
          description: dto.description,
          quantity: new D(dto.quantity ?? '1'),
          unitPrice: new D(dto.unitPrice),
          discount: new D(discount),
          taxRatePercent: new D(dto.taxRatePercent),
        };
      }

      const created = await createItem(tx, tenantId, actor.userId, order.id, line);
      await saveTotals(tx, { id: order.id, items: [...order.items, created] });
      await recordBillingAudit(tx, {
        tenantId,
        actorId: actor.userId,
        action: 'UPDATE',
        entity: 'ORDER',
        entityId: order.id,
        changes: { addedItem: { id: created.id, ...itemSnapshot(line) } },
      });
      return this.view(tx, tenantId, order.id);
    });
  }

  removeItem(
    tenantId: string,
    actorId: string,
    orderId: string,
    itemId: string,
    version: number,
  ): Promise<OrderView> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const order = await loadOrderForWrite(tx, tenantId, orderId, version);
      assertEditable(order);
      const removed = order.items.find((item) => item.id === itemId);
      if (!removed) throw itemNotFound();

      await tx.orderItem.delete({ where: { id: itemId } });
      await saveTotals(tx, {
        id: order.id,
        items: order.items.filter((item) => item.id !== itemId),
      });
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'ORDER',
        entityId: order.id,
        changes: {
          removedItem: {
            id: removed.id,
            treatmentSessionId: removed.treatmentSessionId,
            description: removed.description,
          },
        },
      });
      return this.view(tx, tenantId, order.id);
    });
  }

  updateItemDiscount(
    tenantId: string,
    actorId: string,
    orderId: string,
    itemId: string,
    dto: UpdateOrderItemDto,
  ): Promise<OrderView> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const order = await loadOrderForWrite(tx, tenantId, orderId, dto.version);
      assertEditable(order);
      const target = order.items.find((item) => item.id === itemId);
      if (!target) throw itemNotFound();

      const discount = new D(dto.discount);
      await tx.orderItem.update({ where: { id: itemId }, data: { discount } });
      const items = order.items.map((item) => (item.id === itemId ? { ...item, discount } : item));
      await saveTotals(tx, { id: order.id, items });
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'ORDER',
        entityId: order.id,
        changes: {
          itemDiscount: {
            id: itemId,
            before: new D(target.discount).toFixed(2),
            after: discount.toFixed(2),
          },
        },
      });
      return this.view(tx, tenantId, order.id);
    });
  }

  setBillingProfile(
    tenantId: string,
    actorId: string,
    orderId: string,
    dto: SetOrderBillingProfileDto,
  ): Promise<OrderView> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const order = await loadOrderForWrite(tx, tenantId, orderId, dto.version);
      if (order.status !== 'OPEN' && order.status !== 'PAID') throw notEditable();
      const profile = await activeProfile(tx, tenantId, dto.billingProfileId);

      await tx.order.update({ where: { id: order.id }, data: { billingProfileId: profile.id } });
      await saveTotals(tx, order);
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'ORDER',
        entityId: order.id,
        changes: { billingProfileId: { before: order.billingProfileId, after: profile.id } },
      });
      return this.view(tx, tenantId, order.id);
    });
  }

  cancel(
    tenantId: string,
    actorId: string,
    orderId: string,
    dto: CancelOrderDto,
  ): Promise<OrderView> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const order = await loadOrderForWrite(tx, tenantId, orderId, dto.version);
      if (order.payments.some((payment) => payment.status === 'RECORDED')) throw hasPayments();
      if (order.status !== 'OPEN') throw notEditable();

      const now = new Date();
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledById: actorId,
          cancellationReason: dto.reason,
        },
      });
      await tx.orderItem.updateMany({
        where: { orderId: order.id, releasedAt: null },
        data: { releasedAt: now },
      });
      await saveTotals(tx, order);
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'ORDER',
        entityId: order.id,
        changes: { status: { before: order.status, after: 'CANCELLED' } },
        reason: dto.reason,
      });
      return this.view(tx, tenantId, order.id);
    });
  }

  private async view(
    tx: Prisma.TransactionClient,
    tenantId: string,
    orderId: string,
  ): Promise<OrderView> {
    return toOrderView(await loadOrderForWrite(tx, tenantId, orderId));
  }
}
