import { SetMetadata } from '@nestjs/common';
import { CanonicalRole, toCanonicalRole } from '../roles/role-compatibility';

/** The default actions of each clinic role; the platform can override them per clinic. */
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
    roles: ['MASTER'],
    // Billing is the master role's by default; the platform may grant it to other clinic roles.
    grantable: ['PROFESIONAL', 'ASISTENTE'],
  },
  {
    key: 'billing.create',
    group: 'Facturación',
    label: 'Emitir facturas',
    roles: ['MASTER'],
    grantable: ['PROFESIONAL', 'ASISTENTE'],
  },
  {
    key: 'treatments.manage',
    group: 'Tratamientos',
    label: 'Gestionar tratamientos y consentimientos',
    roles: ['MASTER'],
    grantable: ['PROFESIONAL', 'ASISTENTE'],
  },
  {
    key: 'billing.adjust',
    group: 'Facturación',
    label: 'Aplicar descuentos, conceptos libres y devoluciones',
    roles: ['MASTER'],
    grantable: ['PROFESIONAL', 'ASISTENTE'],
  },
  {
    key: 'cash.manage',
    group: 'Caja',
    label: 'Abrir y cerrar la caja',
    roles: ['MASTER'],
    grantable: ['PROFESIONAL', 'ASISTENTE'],
  },
] as const satisfies readonly {
  key: string;
  group: string;
  label: string;
  roles: readonly CanonicalRole[];
  /** Roles that lack the permission but can receive it through platform configuration. */
  grantable?: readonly CanonicalRole[];
}[];

export type Permission = (typeof PERMISSION_CATALOG)[number]['key'];

export const REQUIRE_PERMISSION_KEY = 'requirePermission';

/**
 * Names the permission a route exercises. The role guard checks whether this role can receive it;
 * the permission guard applies the platform's settings for the clinic.
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

/** The permissions a role lacks by default but the platform can give it in one clinic. */
export function grantablePermissions(role: string): Permission[] {
  const canonical = toCanonicalRole(role);
  return PERMISSION_CATALOG.filter(
    (entry) =>
      !!canonical &&
      ((entry as { grantable?: readonly string[] }).grantable ?? []).includes(canonical),
  ).map((entry) => entry.key);
}

/**
 * What a clinic role can actually do after platform overrides.
 */
export function effectivePermissions(
  role: string,
  revoked: readonly string[],
  granted: readonly string[] = [],
): Permission[] {
  const byRole = rolePermissions(role);
  const extra = grantablePermissions(role).filter((permission) => granted.includes(permission));
  return PERMISSION_CATALOG.map((entry) => entry.key).filter(
    (permission) =>
      (byRole.includes(permission) && !revoked.includes(permission)) || extra.includes(permission),
  );
}
