import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SpecialtiesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForTenant(tenantId: string) {
    const specialties = await this.prisma.tenantSpecialty.findMany({
      where: { tenantId, specialty: { isActive: true } },
      include: {
        specialty: {
          include: { modules: true },
        },
      },
      orderBy: { specialty: { name: 'asc' } },
    });

    return specialties.map(({ specialty }) => specialty);
  }

  async listModulesForTenant(tenantId: string) {
    return this.prisma.tenantModule.findMany({
      where: { tenantId },
      orderBy: { moduleKey: 'asc' },
    });
  }
}
