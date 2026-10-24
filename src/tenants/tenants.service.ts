import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateTenantDto } from './dto/tenant.dto';

@Injectable()
export class TenantsService {
  constructor(private prisma: PrismaService) {}

  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        settings: true,
        subscription: { include: { plan: { select: { id: true, code: true, name: true } } } },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant no encontrado');
    }

    return tenant;
  }

  async update(id: string, updateTenantDto: UpdateTenantDto) {
    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: updateTenantDto,
      include: {
        settings: true,
        subscription: { include: { plan: { select: { id: true, code: true, name: true } } } },
      },
    });

    return tenant;
  }

  async completeOnboarding(id: string) {
    return this.prisma.tenant.update({
      where: { id },
      data: { onboardingCompleted: true },
    });
  }

  async getSubscription(tenantId: string) {
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
    });

    if (!subscription) {
      throw new NotFoundException('Suscripción no encontrada');
    }

    return subscription;
  }

  async updateSubscription(tenantId: string, data: any) {
    return this.prisma.tenantSubscription.update({
      where: { tenantId },
      data,
    });
  }
}
