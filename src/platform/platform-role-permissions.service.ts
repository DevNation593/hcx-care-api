import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  effectivePermissions,
  grantablePermissions,
  isPermission,
  PERMISSION_CATALOG,
  rolePermissions,
} from '../common/permissions/permission-catalog';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAuditService } from './platform-audit.service';

export const CLINIC_ROLES = ['MASTER', 'PROFESIONAL', 'ASISTENTE'] as const;
export type ClinicRole = (typeof CLINIC_ROLES)[number];

export function isClinicRole(role: string): role is ClinicRole {
  return (CLINIC_ROLES as readonly string[]).includes(role);
}

@Injectable()
export class PlatformRolePermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  async describe(tenantId: string, role: string) {
    this.assertRole(role);
    await this.assertClinic(tenantId);
    const rows = await this.prisma.tenantRolePermission.findMany({
      where: { tenantId, role: role as UserRole },
      select: { permission: true, granted: true },
    });
    const revoked = rows.filter((row) => !row.granted).map((row) => row.permission);
    const granted = rows.filter((row) => row.granted).map((row) => row.permission);
    const byRole = rolePermissions(role);
    const grantable = grantablePermissions(role);
    const effective = effectivePermissions(role, revoked, granted);
    return {
      tenantId,
      role,
      effective,
      permissions: PERMISSION_CATALOG.filter(
        (entry) => byRole.includes(entry.key) || grantable.includes(entry.key),
      ).map(({ key, group, label }) => ({
        key,
        group,
        label,
        allowed: effective.includes(key),
        source: byRole.includes(key) ? ('role' as const) : ('grant' as const),
      })),
    };
  }

  async replace(tenantId: string, role: string, actorId: string, allowed: string[]) {
    this.assertRole(role);
    await this.assertClinic(tenantId);
    const byRole = rolePermissions(role);
    const grantable = grantablePermissions(role);
    const selectable = new Set<string>([...byRole, ...grantable]);
    const unique = [...new Set(allowed)];
    const invalid = unique.find(
      (permission) => !isPermission(permission) || !selectable.has(permission),
    );
    if (invalid !== undefined) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'PERMISSION_INVALID',
        message: `El permiso ${invalid} no corresponde al rol ${role}.`,
      });
    }
    const rows = [
      ...byRole
        .filter((permission) => !unique.includes(permission))
        .map((permission) => ({ permission, granted: false })),
      ...grantable
        .filter((permission) => unique.includes(permission))
        .map((permission) => ({ permission, granted: true })),
    ];
    await this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx, { tenantId, userId: actorId, role: 'ADMIN' });
      const previous = await tx.tenantRolePermission.findMany({
        where: { tenantId, role: role as UserRole },
        select: { permission: true, granted: true },
      });
      await tx.tenantRolePermission.deleteMany({ where: { tenantId, role: role as UserRole } });
      if (rows.length) {
        await tx.tenantRolePermission.createMany({
          data: rows.map((row) => ({
            tenantId,
            role: role as UserRole,
            createdById: actorId,
            ...row,
          })),
        });
      }
      const allowedBefore = effectivePermissions(
        role,
        previous.filter((row) => !row.granted).map((row) => row.permission),
        previous.filter((row) => row.granted).map((row) => row.permission),
      );
      const allowedAfter = effectivePermissions(
        role,
        rows.filter((row) => !row.granted).map((row) => row.permission),
        rows.filter((row) => row.granted).map((row) => row.permission),
      );
      await this.audit.record(
        {
          tenantId,
          actorId,
          entity: 'TENANT',
          entityId: tenantId,
          changes: {
            before: { role, allowed: allowedBefore },
            after: { role, allowed: allowedAfter },
          },
        },
        tx,
      );
    });
    return this.describe(tenantId, role);
  }

  private assertRole(role: string): asserts role is ClinicRole {
    if (!isClinicRole(role)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'ROLE_INVALID',
        message: 'Rol no configurable.',
      });
    }
  }

  private async assertClinic(tenantId: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, isPlatform: false },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException('Consultorio no encontrado');
  }
}
