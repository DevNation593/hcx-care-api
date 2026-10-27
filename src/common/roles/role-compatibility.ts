export type CanonicalRole =
  | 'MASTER'
  | 'PROFESIONAL'
  | 'ASISTENTE'
  | 'CAJERO'
  | 'SOPORTE'
  | 'PACIENTE'
  | 'ADMIN';

const CANONICAL_ROLES: readonly string[] = [
  'MASTER',
  'PROFESIONAL',
  'ASISTENTE',
  'CAJERO',
  'SOPORTE',
  'PACIENTE',
  'ADMIN',
];

/** CLIENTE and PSICOLOGO were migrated away; they resolve to nothing so they match no guard. */
export function toCanonicalRole(role: string): CanonicalRole | undefined {
  return CANONICAL_ROLES.includes(role) ? (role as CanonicalRole) : undefined;
}

export function areRolesEquivalent(actual: string, required: string): boolean {
  const actualCanonical = toCanonicalRole(actual);
  return !!actualCanonical && actualCanonical === toCanonicalRole(required);
}

export const isMasterRole = (role: string): boolean => role === 'MASTER';
export const isProfessionalRole = (role: string): boolean => role === 'PROFESIONAL';
export const isCashierRole = (role: string): boolean => role === 'CAJERO';
