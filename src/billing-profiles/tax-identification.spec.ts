import {
  assertValidTaxIdentification,
  isValidCedula,
  normalizeIdNumber,
} from './tax-identification';

describe('tax-identification', () => {
  describe('normalizeIdNumber', () => {
    it('strips spaces and hyphens', () => {
      expect(normalizeIdNumber('05', ' 1710034065 ')).toBe('1710034065');
    });

    it('uppercases passports', () => {
      expect(normalizeIdNumber('06', 'ab-123')).toBe('AB123');
    });
  });

  describe('isValidCedula', () => {
    it('accepts a valid cedula', () => {
      expect(isValidCedula('1710034065')).toBe(true);
    });

    it('rejects a wrong check digit', () => {
      expect(isValidCedula('1710034066')).toBe(false);
    });
  });

  describe('assertValidTaxIdentification', () => {
    it.each([
      ['05', '1710034065', 'Ana'],
      ['04', '1710034065001', 'Empresa'],
      ['04', '1790012345001', 'Empresa'],
      ['04', '1760001550001', 'Entidad publica'],
      ['06', 'AB123', 'Ana'],
      ['07', '9999999999999', 'Consumidor Final'],
    ])('accepts (%s, %s)', (idType, idNumber, legalName) => {
      expect(() => assertValidTaxIdentification(idType, idNumber, legalName)).not.toThrow();
    });

    it.each([
      ['05', '1710034066', 'Ana'],
      ['05', '2510034065', 'Ana'],
      ['05', '1760034065', 'Ana'],
      ['05', '171003406', 'Ana'],
      ['04', '1710034065002', 'Empresa'],
      ['04', '1710034066001', 'Empresa'],
      ['04', '1780012345001', 'Empresa'],
      ['04', '9999999999999', 'Empresa'],
      ['06', 'A*1', 'Ana'],
      ['06', 'AB', 'Ana'],
      ['07', '9999999999999', 'Ana'],
      ['03', '1710034065', 'Ana'],
    ])('rejects (%s, %s)', (idType, idNumber, legalName) => {
      try {
        assertValidTaxIdentification(idType, idNumber, legalName);
        throw new Error('expected to throw');
      } catch (error) {
        expect((error as { getResponse?: () => unknown }).getResponse?.()).toEqual(
          expect.objectContaining({
            statusCode: 422,
            code: 'BILLING_PROFILE_INVALID',
          }),
        );
      }
    });
  });
});
