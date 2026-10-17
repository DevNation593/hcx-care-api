import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CashRegisterSession, PaymentMethod, Prisma } from '@prisma/client';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import { CashCount, computeCashCount } from './cash-count';
import {
  CloseCashRegisterDto,
  ListCashRegistersQuery,
  OpenCashRegisterDto,
} from './dto/cash-register.dto';

const DEFAULT_PAGE_SIZE = 20;

type MoneyFields = 'openingCash' | 'expectedCash' | 'countedCash' | 'difference';

/** A cash register as the API returns it: amounts are strings with 2 decimals. */
export type CashRegisterView = Omit<CashRegisterSession, MoneyFields> & {
  openingCash: string;
  expectedCash: string | null;
  countedCash: string | null;
  difference: string | null;
};

export interface CashRegisterSummary {
  expectedCash: string;
  byMethod: Record<PaymentMethod, { received: string; refunded: string }>;
}

export type CashRegisterDetail = CashRegisterView & { summary: CashRegisterSummary };

const money = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value).toFixed(2);
const moneyOrNull = (value: Prisma.Decimal | null) => (value === null ? null : money(value));

function toView(session: CashRegisterSession): CashRegisterView {
  return {
    ...session,
    openingCash: money(session.openingCash),
    expectedCash: moneyOrNull(session.expectedCash),
    countedCash: moneyOrNull(session.countedCash),
    difference: moneyOrNull(session.difference),
  };
}

function toSummary(count: CashCount): CashRegisterSummary {
  return {
    expectedCash: money(count.expectedCash),
    byMethod: Object.fromEntries(
      Object.entries(count.byMethod).map(([method, { received, refunded }]) => [
        method,
        { received: money(received), refunded: money(refunded) },
      ]),
    ) as CashRegisterSummary['byMethod'],
  };
}

const branchNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'BRANCH_NOT_FOUND',
    message: 'Sucursal no encontrada.',
  });

const registerNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'CASH_REGISTER_NOT_FOUND',
    message: 'Caja no encontrada.',
  });

const alreadyOpen = () =>
  new ConflictException({
    statusCode: 409,
    code: 'CASH_REGISTER_ALREADY_OPEN',
    message: 'La sucursal ya tiene una caja abierta.',
  });

const registerClosed = () =>
  new ConflictException({
    statusCode: 409,
    code: 'CASH_REGISTER_CLOSED',
    message: 'La caja de la sucursal está cerrada.',
  });

const noteRequired = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'CASH_CLOSING_NOTE_REQUIRED',
    message: 'El efectivo contado no coincide con el esperado: ingrese una nota de cierre.',
  });

const isUniqueViolation = (error: unknown) =>
  (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';

/** The open cash register of the branch, or 409 CASH_REGISTER_CLOSED when there is none. */
export async function findOpenCashRegister(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<CashRegisterSession> {
  const session = await tx.cashRegisterSession.findFirst({
    where: { tenantId, branchId, status: 'OPEN' },
  });
  if (!session) throw registerClosed();
  return session;
}

@Injectable()
export class CashRegistersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, query: ListCashRegistersQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.CashRegisterSessionWhereInput = {
      tenantId,
      ...(query.branchId ? { branchId: query.branchId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.cashRegisterSession.findMany({
        where,
        orderBy: { openedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.cashRegisterSession.count({ where }),
    ]);
    return { items: items.map(toView), total, page, pageSize };
  }

  open(tenantId: string, actorId: string, dto: OpenCashRegisterDto): Promise<CashRegisterDetail> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: dto.branchId, tenantId, isActive: true },
        select: { id: true },
      });
      if (!branch) throw branchNotFound();

      const existing = await tx.cashRegisterSession.findFirst({
        where: { tenantId, branchId: branch.id, status: 'OPEN' },
        select: { id: true },
      });
      if (existing) throw alreadyOpen();

      let session: CashRegisterSession;
      try {
        session = await tx.cashRegisterSession.create({
          data: {
            tenantId,
            branchId: branch.id,
            status: 'OPEN',
            openedById: actorId,
            openingCash: new Prisma.Decimal(dto.openingCash),
          },
        });
      } catch (error) {
        // The partial unique index lost a race with another opening.
        if (isUniqueViolation(error)) throw alreadyOpen();
        throw error;
      }

      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'CREATE',
        entity: 'CASH_REGISTER',
        entityId: session.id,
        changes: { branchId: session.branchId, openingCash: money(session.openingCash) },
      });
      const count = computeCashCount(session.openingCash, [], []);
      return { ...toView(session), summary: toSummary(count) };
    });
  }

  async get(tenantId: string, id: string): Promise<CashRegisterDetail> {
    const session = await this.prisma.cashRegisterSession.findFirst({ where: { id, tenantId } });
    if (!session) throw registerNotFound();
    const count = await this.count(this.prisma, session);
    return { ...toView(session), summary: toSummary(count) };
  }

  close(
    tenantId: string,
    actorId: string,
    id: string,
    dto: CloseCashRegisterDto,
  ): Promise<CashRegisterDetail> {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const session = await tx.cashRegisterSession.findFirst({ where: { id, tenantId } });
      if (!session) throw registerNotFound();
      if (session.status === 'CLOSED') throw registerClosed();

      const count = await this.count(tx, session);
      const countedCash = new Prisma.Decimal(dto.countedCash);
      const difference = countedCash.sub(count.expectedCash);
      if (!difference.isZero() && !dto.closingNote) throw noteRequired();

      const closed = await tx.cashRegisterSession.update({
        where: { id: session.id },
        data: {
          status: 'CLOSED',
          closedById: actorId,
          closedAt: new Date(),
          expectedCash: count.expectedCash,
          countedCash,
          difference,
          closingNote: dto.closingNote ?? null,
        },
      });
      await recordBillingAudit(tx, {
        tenantId,
        actorId,
        action: 'UPDATE',
        entity: 'CASH_REGISTER',
        entityId: session.id,
        changes: {
          status: { from: 'OPEN', to: 'CLOSED' },
          expectedCash: money(count.expectedCash),
          countedCash: money(countedCash),
          difference: money(difference),
        },
      });
      return { ...toView(closed), summary: toSummary(count) };
    });
  }

  /**
   * Cash count of a register: every payment received in it (refunded ones included, since the
   * cash did come in) against every payment refunded while it was open.
   */
  private async count(
    client: Pick<Prisma.TransactionClient, 'payment'>,
    session: CashRegisterSession,
  ): Promise<CashCount> {
    const select = { method: true, amount: true } as const;
    const [received, refunded] = await Promise.all([
      client.payment.findMany({
        where: { tenantId: session.tenantId, cashRegisterSessionId: session.id },
        select,
      }),
      client.payment.findMany({
        where: { tenantId: session.tenantId, refundCashRegisterSessionId: session.id },
        select,
      }),
    ]);
    return computeCashCount(session.openingCash, received, refunded);
  }
}
