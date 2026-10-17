import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateTenantSettingsDto } from './dto/tenant-settings.dto';

@Injectable()
export class TenantSettingsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Get tenant settings
   */
  async findOne(tenantId: string) {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      include: {
        tenant: {
          select: {
            legalName: true,
            taxIdentificationType: true,
            taxIdentificationNumber: true,
          },
        },
      },
    });

    if (!settings) {
      throw new NotFoundException('Configuración del tenant no encontrada');
    }

    return {
      ...settings,
      legalName: settings.tenant.legalName,
      taxIdentificationType: settings.tenant.taxIdentificationType,
      taxIdentificationNumber: settings.tenant.taxIdentificationNumber,
      tenant: undefined,
    };
  }

  /**
   * Update tenant settings
   */
  async update(tenantId: string, updateDto: UpdateTenantSettingsDto) {
    // Check settings exist
    const existing = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
    });

    if (!existing) {
      throw new NotFoundException('Configuración del tenant no encontrada');
    }

    // Validate working hours order if both provided
    const start = updateDto.workingHoursStart ?? existing.workingHoursStart;
    const end = updateDto.workingHoursEnd ?? existing.workingHoursEnd;

    if (start >= end) {
      throw new BadRequestException('La hora de fin debe ser posterior a la hora de inicio');
    }

    // Validate working days values
    const validDays = [
      'MONDAY',
      'TUESDAY',
      'WEDNESDAY',
      'THURSDAY',
      'FRIDAY',
      'SATURDAY',
      'SUNDAY',
    ];
    if (updateDto.workingDays) {
      const invalidDays = updateDto.workingDays.filter((d) => !validDays.includes(d));
      if (invalidDays.length > 0) {
        throw new BadRequestException(
          `Días laborales inválidos: ${invalidDays.join(', ')}. Valores válidos: ${validDays.join(', ')}`,
        );
      }
    }

    const { legalName, taxIdentificationType, taxIdentificationNumber, ...settingsData } =
      updateDto;
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSettings.update({
        where: { tenantId },
        data: settingsData,
      });

      await tx.tenant.update({
        where: { id: tenantId },
        data: { legalName, taxIdentificationType, taxIdentificationNumber },
      });
    });

    return this.findOne(tenantId);
  }
}
