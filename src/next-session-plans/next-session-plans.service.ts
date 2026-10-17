import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { LEGACY_BILLING_OMIT } from '../patients/legacy-billing';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_USER_SELECT } from '../common/utils/public-user-select';
import { CreateNextSessionPlanDto, UpdateNextSessionPlanDto } from './dto/next-session-plan.dto';

@Injectable()
export class NextSessionPlansService {
  constructor(private prisma: PrismaService) {}

  async create(tenantId: string, psychologistId: string, createDto: CreateNextSessionPlanDto) {
    const { patientId, ...planData } = createDto;

    // Verify patient belongs to tenant
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenantId },
    });

    if (!patient) {
      throw new NotFoundException('Paciente no encontrado');
    }

    // Check if plan already exists for this patient
    const existing = await this.prisma.nextSessionPlan.findUnique({
      where: { patientId },
    });

    if (existing) {
      throw new ConflictException(
        'Ya existe un plan de sesión para este paciente. Use actualizar en su lugar.',
      );
    }

    const plan = await this.prisma.nextSessionPlan.create({
      data: {
        ...planData,
        tenantId,
        patientId,
        psychologistId,
      },
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        psychologist: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    return plan;
  }

  async findByPatient(tenantId: string, patientId: string) {
    const plan = await this.prisma.nextSessionPlan.findFirst({
      where: { tenantId, patientId },
      include: {
        patient: { omit: LEGACY_BILLING_OMIT },
        psychologist: { select: PUBLIC_USER_SELECT },
      },
    });

    return plan;
  }

  async findAll(tenantId: string, psychologistId?: string) {
    const where: any = { tenantId };

    if (psychologistId) {
      where.psychologistId = psychologistId;
    }

    const plans = await this.prisma.nextSessionPlan.findMany({
      where,
      include: {
        patient: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        psychologist: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return plans;
  }

  async update(
    tenantId: string,
    patientId: string,
    psychologistId: string,
    updateDto: UpdateNextSessionPlanDto,
  ) {
    const plan = await this.prisma.nextSessionPlan.findFirst({
      where: { tenantId, patientId },
    });

    if (!plan) {
      throw new NotFoundException('Plan de sesión no encontrado');
    }

    return this.prisma.nextSessionPlan.update({
      where: { id: plan.id },
      data: {
        ...updateDto,
        psychologistId, // Update psychologist if different
      },
      include: {
        patient: { omit: LEGACY_BILLING_OMIT },
        psychologist: { select: PUBLIC_USER_SELECT },
      },
    });
  }

  async delete(tenantId: string, patientId: string) {
    const plan = await this.prisma.nextSessionPlan.findFirst({
      where: { tenantId, patientId },
    });

    if (!plan) {
      throw new NotFoundException('Plan de sesión no encontrado');
    }

    await this.prisma.nextSessionPlan.delete({
      where: { id: plan.id },
    });

    return { message: 'Plan de sesión eliminado exitosamente' };
  }
}
