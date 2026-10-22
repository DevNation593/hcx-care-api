import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isHealthSpecialty } from '../clinical-modules/clinical-module-registry';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Clinical notes and next session plans are health care: a professional whose own specialty
 * is not (Estética) cannot write them, even in a clinic where the section is on for others.
 * An account without a profile is left to the guards that already decide about it.
 */
@Injectable()
export class HealthSpecialtyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest().user;
    if (!user?.userId) return true;

    const profile = await this.prisma.professionalProfile.findFirst({
      where: {
        userId: user.userId,
        isActive: true,
        user: { tenantId: user.tenantId, isActive: true },
      },
      select: { specialty: { select: { code: true } } },
    });
    if (profile && !isHealthSpecialty(profile.specialty?.code)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'HEALTH_SPECIALTY_REQUIRED',
        message: 'Las especialidades no clínicas no registran notas clínicas ni planes de sesión.',
      });
    }
    return true;
  }
}
