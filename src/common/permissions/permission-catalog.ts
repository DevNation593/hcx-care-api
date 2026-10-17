import { SetMetadata } from '@nestjs/common';
import { CanonicalRole, toCanonicalRole } from '../roles/role-compatibility';

/**
 * What a role allows, action by action. The account holder can take a permission of the role
 * away from one user, and can give a user one their role lacks only when the entry lists that
 * role in `grantable`. The account holder (MASTER) always keeps every permission.
 */
export const PERMISSION_CATALOG = [
  {
    key: 'patients.create',
    group: 'Pacientes',
    label: 'Registrar pacientes',
    roles: ['MASTER', 'ASISTENTE', 'PROFESIONAL'],
  },
  {
    key: 'patients.update',
    group: 'Pacientes',
    label: 'Editar pacientes',
    roles: ['MASTER', 'ASISTENTE', 'PROFESIONAL'],
  },
  {
    key: 'appointments.create',
    group: 'Agenda',
    label: 'Agendar citas',
    roles: ['MASTER', 'ASISTENTE', 'PROFESIONAL'],
  },
  {
    key: 'appointments.update',
    group: 'Agenda',
    label: 'Modificar citas',
    roles: ['MASTER', 'ASISTENTE', 'PROFESIONAL'],
  },
  {
    key: 'appointments.cancel',
    group: 'Agenda',
    label: 'Cancelar citas',
    roles: ['MASTER', 'ASISTENTE', 'PROFESIONAL'],
  },
  {
    key: 'clinical_records.view',
    group: 'Historia clínica',
    label: 'Ver la historia clínica',
    roles: ['MASTER', 'PROFESIONAL'],
  },
  {
    key: 'clinical_records.create',
    group: 'Historia clínica',
    label: 'Crear atenciones, notas y registros',
    roles: ['MASTER', 'PROFESIONAL'],
  },
  {
    key: 'clinical_records.update',
    group: 'Historia clínica',
    label: 'Corregir y eliminar sus registros',
    roles: ['MASTER', 'PROFESIONAL'],
  },
  {
    key: 'billing.view',
    group: 'Facturación',
    label: 'Ver facturas',
    roles: ['MASTER', 'PROFESIONAL'],
    // Whoever works at the front desk can be put in charge of invoicing.
    grantable: ['ASISTENTE'],
  },
  {
    key: 'billing.create',
    group: 'Facturación',
    label: 'Emitir facturas',
    roles: ['MASTER', 'PROFESIONAL'],
    grantable: ['ASISTENTE'],
  },
  {
    key: 'treatments.manage',
    group: 'Tratamientos',
    label: 'Gestionar tratamientos y consentimientos',
    roles: ['MASTER'],
    grantable: ['PROFESIONAL', 'ASISTENTE'],
  },
] as const satisfies readonly {
  key: string;
  group: string;
  label: string;
  roles: readonly CanonicalRole[];
  /** Roles that lack the permission but can receive it, user by user. */
  grantable?: readonly CanonicalRole[];
}[];

export type Permission = (typeof PERMISSION_CATALOG)[number]['key'];

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/**
 * Names the permission a route exercises. The role guard still decides who may call it;
 * this lets the account holder take the action away from one user.
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);

export function isPermission(value: string): value is Permission {
  return PERMISSION_CATALOG.some((entry) => entry.key === value);
}

/** The permissions a role has before any restriction. */
export function rolePermissions(role: string): Permission[] {
  const canonical = toCanonicalRole(role);
  return PERMISSION_CATALOG.filter(
    (entry) => !!canonical && (entry.roles as readonly string[]).includes(canonical),
  ).map((entry) => entry.key);
}

/** The permissions a role lacks but one of its users can be given. */
export function grantablePermissions(role: string): Permission[] {
  const canonical = toCanonicalRole(role);
  return PERMISSION_CATALOG.filter(
    (entry) =>
      !!canonical &&
      ((entry as { grantable?: readonly string[] }).grantable ?? []).includes(canonical),
  ).map((entry) => entry.key);
}

/**
 * What the user can actually do: the role's permissions minus the ones withdrawn, plus the
 * ones given to them among those their role can receive.
 */
export function effectivePermissions(
  role: string,
  revoked: readonly string[],
  granted: readonly string[] = [],
): Permission[] {
  const byRole = rolePermissions(role);
  // The account holder cannot be restricted, whatever rows exist.
  if (role === 'MASTER') return byRole;

  const extra = grantablePermissions(role).filter((permission) => granted.includes(permission));
  return PERMISSION_CATALOG.map((entry) => entry.key).filter(
    (permission) =>
      (byRole.includes(permission) && !revoked.includes(permission)) || extra.includes(permission),
  );
}
