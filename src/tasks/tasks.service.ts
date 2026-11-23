import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LEGACY_BILLING_OMIT } from '../patients/legacy-billing';
import { toCanonicalRole } from '../common/roles/role-compatibility';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_USER_SELECT } from '../common/utils/public-user-select';
import { isPaginated, pageMeta, PageRequest, pageWindow } from '../common/pagination/pagination';
import { escapeLike } from '../common/pagination/escape-like';
import { readInTransaction } from '../common/pagination/read-in-transaction';
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto';

export type TaskActor = { userId: string; role: string };

export type TaskSummaryFilters = {
  patientId?: string;
  assignedToId?: string;
  priority?: string;
  search?: string;
};

export type TaskFilters = TaskSummaryFilters & PageRequest & { status?: string };

const TASK_ASSIGNEE_ROLES: string[] = ['MASTER', 'ASISTENTE', 'PROFESIONAL'];

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  private isProfessional(actor: TaskActor): boolean {
    return toCanonicalRole(actor.role) === 'PROFESIONAL';
  }

  /** A professional only works with tasks they created or were assigned; other roles see the clinic's. */
  private visibilityFilter(actor: TaskActor) {
    if (!this.isProfessional(actor)) return {};
    return { AND: [{ OR: [{ createdById: actor.userId }, { assignedToId: actor.userId }] }] };
  }

  private assertCanAssign(actor: TaskActor, assignedToId: string | undefined) {
    if (this.isProfessional(actor) && assignedToId && assignedToId !== actor.userId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'TASK_ASSIGNMENT_FORBIDDEN',
        message: 'Solo puedes asignarte actividades a ti mismo.',
      });
    }
  }

  private async assertAssignableUserBelongsToTenant(tenantId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, isActive: true },
    });

    if (!user) {
      throw new NotFoundException('Usuario asignado no encontrado en esta clínica');
    }

    // Tasks carry patient data; staff without clinical access (cashier) cannot receive them.
    if (!TASK_ASSIGNEE_ROLES.includes(toCanonicalRole(user.role) as string)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'TASK_ASSIGNEE_NOT_ALLOWED',
        message: 'Solo se pueden asignar actividades al titular, a profesionales o a asistentes.',
      });
    }
  }

  async create(tenantId: string, actor: TaskActor, createTaskDto: CreateTaskDto) {
    const { patientId, dueDate, ...taskData } = createTaskDto;
    const createdById = actor.userId;
    this.assertCanAssign(actor, taskData.assignedToId);
    // A professional's task is their own unless an administrator assigns it elsewhere.
    if (this.isProfessional(actor) && !taskData.assignedToId) {
      taskData.assignedToId = actor.userId;
    }

    // Verify patient belongs to tenant
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId },
    });

    if (!patient) {
      throw new NotFoundException('Paciente no encontrado');
    }

    if (taskData.assignedToId) {
      await this.assertAssignableUserBelongsToTenant(tenantId, taskData.assignedToId);
    }

    const task = await this.prisma.task.create({
      data: {
        title: taskData.title,
        description: taskData.description,
        priority: taskData.priority as any,
        ...(taskData.assignedToId && {
          assignedTo: {
            connect: { id: taskData.assignedToId },
          },
        }),
        tenant: {
          connect: { id: tenantId },
        },
        patient: {
          connect: { id: patientId },
        },
        createdBy: {
          connect: { id: createdById },
        },
        dueDate: dueDate ? new Date(dueDate) : null,
      },
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        assignedTo: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    return task;
  }

  /** Tenant, the actor's visibility and the filters of the list; shared by the list, its total and the summary. */
  private listWhere(tenantId: string, filters: TaskFilters | undefined, actor: TaskActor) {
    const where: any = { tenantId, ...this.visibilityFilter(actor) };

    if (filters?.patientId) {
      where.patientId = filters.patientId;
    }

    if (filters?.assignedToId) {
      where.assignedToId = filters.assignedToId;
    }

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.priority) {
      where.priority = filters.priority;
    }

    if (filters?.search) {
      // Prisma does not escape the LIKE wildcards of `contains`: "%" or "_" would match every task.
      const term = escapeLike(filters.search);
      // Top-level OR: the professional's visibility lives under AND, so the two never mix.
      where.OR = [
        { title: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { patient: { firstName: { contains: term, mode: 'insensitive' } } },
        { patient: { lastName: { contains: term, mode: 'insensitive' } } },
      ];
    }

    return where;
  }

  /**
   * Without `page`/`limit` this is the whole list as an array (mobile, dashboard, selectors).
   * With either one it is a page: `{ data, meta }`. Both use the same `where`.
   */
  async findAll(tenantId: string, filters: TaskFilters | undefined, actor: TaskActor) {
    const where = this.listWhere(tenantId, filters, actor);

    const query = {
      where,
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        assignedTo: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    };

    // Without `page`/`limit` the list is returned whole, as an array (mobile and selectors).
    if (!isPaginated(filters)) {
      return this.prisma.task.findMany({
        ...query,
        orderBy: [{ dueDate: 'asc' }, { priority: 'desc' }],
      });
    }

    const { page, limit, skip, take } = pageWindow(filters ?? {});
    // One transaction, queries in sequence on `tx` (see readInTransaction).
    return readInTransaction(this.prisma, async (tx) => {
      const total = await tx.task.count({ where });
      const data = await tx.task.findMany({
        ...query,
        // Pages run through the groups the task screen shows: open tasks first, then completed,
        // then cancelled. TaskStatus is declared PENDING, IN_PROGRESS, COMPLETED, CANCELLED and
        // PostgreSQL sorts an enum by its declaration order. Within a group: due date, priority,
        // and `id` so no task repeats or vanishes between pages. Only the paged list sorts this
        // way; the unpaged one keeps the order it always had.
        orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { priority: 'desc' }, { id: 'asc' }],
        skip,
        take,
      });
      return { data, meta: pageMeta(total, page, limit) };
    });
  }

  /**
   * Counts per state for the headings of the task page, which cannot be added up from one page.
   * Same tenant and visibility as the list; `status` is not a filter here, it is what is counted.
   * `pending` is PENDING plus IN_PROGRESS, `overdue` those of them past their due date.
   */
  async summary(tenantId: string, filters: TaskSummaryFilters | undefined, actor: TaskActor) {
    const where = this.listWhere(tenantId, filters, actor);
    // One transaction, queries in sequence on `tx` (see readInTransaction).
    return readInTransaction(this.prisma, async (tx) => {
      const groups = await tx.task.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      });
      const overdue = await tx.task.count({
        where: {
          ...where,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
          dueDate: { lt: new Date() },
        },
      });
      const of = (status: string) =>
        groups.find((group) => group.status === status)?._count._all ?? 0;

      return {
        pending: of('PENDING') + of('IN_PROGRESS'),
        overdue,
        completed: of('COMPLETED'),
        cancelled: of('CANCELLED'),
      };
    });
  }

  async findOne(tenantId: string, taskId: string, actor: TaskActor) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, tenantId, ...this.visibilityFilter(actor) },
      include: {
        patient: { omit: LEGACY_BILLING_OMIT },
        createdBy: { select: PUBLIC_USER_SELECT },
        assignedTo: { select: PUBLIC_USER_SELECT },
      },
    });

    if (!task) {
      throw new NotFoundException('Actividad no encontrada');
    }

    return task;
  }

  async update(tenantId: string, taskId: string, updateTaskDto: UpdateTaskDto, actor: TaskActor) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, tenantId, ...this.visibilityFilter(actor) },
    });

    if (!task) {
      throw new NotFoundException('Actividad no encontrada');
    }

    this.assertCanAssign(actor, updateTaskDto.assignedToId);

    const updateData: any = { ...updateTaskDto };

    if (updateTaskDto.assignedToId) {
      await this.assertAssignableUserBelongsToTenant(tenantId, updateTaskDto.assignedToId);
    }

    // If marking as completed, set completedAt
    if (updateTaskDto.status === 'COMPLETED' && task.status !== 'COMPLETED') {
      updateData.completedAt = new Date();
    }

    return this.prisma.task.update({
      where: { id: taskId },
      data: updateData,
      include: {
        patient: { omit: LEGACY_BILLING_OMIT },
        createdBy: { select: PUBLIC_USER_SELECT },
        assignedTo: { select: PUBLIC_USER_SELECT },
      },
    });
  }

  async delete(tenantId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, tenantId },
    });

    if (!task) {
      throw new NotFoundException('Actividad no encontrada');
    }

    await this.prisma.task.delete({
      where: { id: taskId },
    });

    return { message: 'Actividad eliminada exitosamente' };
  }
}
