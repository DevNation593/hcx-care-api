import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isMasterRole, isProfessionalRole } from '../common/roles/role-compatibility';
import { ProfessionalProfileInputDto } from './dto/professional-profile.dto';

type ProfileDb = PrismaService | Prisma.TransactionClient;

@Injectable()
export class ProfessionalProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  validateRoleProfile(role: string, input?: ProfessionalProfileInputDto): void {
    if (isProfessionalRole(role) && !input) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PROFESSIONAL_SPECIALTY_REQUIRED',
        message: 'El profesional debe tener exactamente una especialidad.',
      });
    }
    if (!isProfessionalRole(role) && !isMasterRole(role) && input) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PROFESSIONAL_PROFILE_NOT_ALLOWED',
        message: 'El rol seleccionado no admite un perfil profesional.',
      });
    }
  }

  async assertSpecialtyEnabled(
    tenantId: string,
    specialtyId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db: ProfileDb = tx ?? this.prisma;
    const enabled = await db.tenantSpecialty.findUnique({
      where: { tenantId_specialtyId: { tenantId, specialtyId } },
    });
    if (!enabled) {
      throw new ConflictException({
        statusCode: 409,
        code: 'SPECIALTY_NOT_ENABLED',
        message: 'La especialidad no está habilitada para este consultorio.',
      });
    }
  }

  async countActiveProfiles(tenantId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const db: ProfileDb = tx ?? this.prisma;
    return db.professionalProfile.count({ where: { isActive: true, user: { tenantId } } });
  }

  async assertSeatAvailable(tenantId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db: ProfileDb = tx ?? this.prisma;
    const [subscription, used] = await Promise.all([
      db.tenantSubscription.findUnique({ where: { tenantId } }),
      this.countActiveProfiles(tenantId, tx),
    ]);
    if (!subscription || used >= subscription.seatsPsychologistsMax) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PROFESSIONAL_SEAT_LIMIT_REACHED',
        message: 'Se alcanzó el límite de profesionales activos del plan.',
        details: { used, limit: subscription?.seatsPsychologistsMax ?? 0 },
      });
    }
  }

  async assertSpecialtyChangeAllowed(
    tenantId: string,
    userId: string,
    nextSpecialtyId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db: ProfileDb = tx ?? this.prisma;
    const current = await db.professionalProfile.findUnique({ where: { userId } });
    if (!current || current.specialtyId === nextSpecialtyId) return;
    const futureAppointments = await db.appointment.count({
      where: {
        tenantId,
        psychologistId: userId,
        specialtyId: current.specialtyId,
        startTime: { gte: new Date() },
        status: { in: ['SCHEDULED', 'CONFIRMED'] },
      },
    });
    if (futureAppointments > 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'SPECIALTY_IN_USE',
        message: 'No se puede cambiar la especialidad mientras existan citas futuras.',
      });
    }
  }

  async syncStoredSeatCount(tenantId: string, tx: Prisma.TransactionClient): Promise<number> {
    const used = await this.countActiveProfiles(tenantId, tx);
    await tx.tenantSubscription.update({
      where: { tenantId },
      data: { seatsPsychologistsUsed: used },
    });
    return used;
  }
}
