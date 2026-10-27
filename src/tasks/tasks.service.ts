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
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto';

export type TaskActor = { userId: string; role: string };

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

  async findAll(
    tenantId: string,
    filters:
      | {
          patientId?: string;
          assignedToId?: string;
          status?: string;
          priority?: string;
        }
      | undefined,
    actor: TaskActor,
  ) {
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

    const tasks = await this.prisma.task.findMany({
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
      orderBy: [{ dueDate: 'asc' }, { priority: 'desc' }],
    });

    return tasks;
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
