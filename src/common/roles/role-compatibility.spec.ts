import {
  areRolesEquivalent,
  isCashierRole,
  isMasterRole,
  isProfessionalRole,
  toCanonicalRole,
} from './role-compatibility';

describe('role compatibility', () => {
  it.each([
    'MASTER',
    'PROFESIONAL',
    'ASISTENTE',
    'CAJERO',
    'SOPORTE',
    'PACIENTE',
    'ADMIN',
  ] as const)('keeps %s as a canonical role', (role) => {
    expect(toCanonicalRole(role)).toBe(role);
  });

  it.each(['CLIENTE', 'PSICOLOGO', 'OTRO', ''])('does not resolve %s', (role) => {
    expect(toCanonicalRole(role)).toBeUndefined();
  });

  it('compares roles by identity, without aliases', () => {
    expect(areRolesEquivalent('MASTER', 'MASTER')).toBe(true);
    expect(areRolesEquivalent('ADMIN', 'MASTER')).toBe(false);
    expect(areRolesEquivalent('CLIENTE', 'MASTER')).toBe(false);
    expect(areRolesEquivalent('PSICOLOGO', 'PROFESIONAL')).toBe(false);
    expect(areRolesEquivalent('CLIENTE', 'CLIENTE')).toBe(false);
  });

  it('classifies the cashier', () => {
    expect(isCashierRole('CAJERO')).toBe(true);
    expect(isCashierRole('ASISTENTE')).toBe(false);
    expect(isCashierRole('MASTER')).toBe(false);
  });

  it('classifies the account holder and professionals', () => {
    expect(isMasterRole('MASTER')).toBe(true);
    expect(isMasterRole('ADMIN')).toBe(false);
    expect(isMasterRole('CLIENTE')).toBe(false);
    expect(isProfessionalRole('PROFESIONAL')).toBe(true);
    expect(isProfessionalRole('PSICOLOGO')).toBe(false);
    expect(isProfessionalRole('MASTER')).toBe(false);
  });
});
