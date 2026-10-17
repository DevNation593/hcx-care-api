import { UnprocessableEntityException } from '@nestjs/common';

export type SriIdType = '04' | '05' | '06' | '07';

export const FINAL_CONSUMER_ID = '9999999999999';
export const FINAL_CONSUMER_NAME = 'CONSUMIDOR FINAL';

/** Strips spaces and hyphens; passports are also uppercased. */
export function normalizeIdNumber(idType: SriIdType, raw: string): string {
  const cleaned = raw.replace(/[\s-]/g, '');
  return idType === '06' ? cleaned.toUpperCase() : cleaned;
}

/** Ecuadorian cedula: 10 digits, valid province, third digit 0-5, modulo 10 check digit. */
export function isValidCedula(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const province = Number(value.slice(0, 2));
  if (!((province >= 1 && province <= 24) || province === 30)) return false;
  if (Number(value[2]) > 5) return false;

  const coefficients = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  const sum = coefficients.reduce((acc, coefficient, index) => {
    let product = coefficient * Number(value[index]);
    if (product > 9) product -= 9;
    return acc + product;
  }, 0);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(value[9]);
}

function invalid(message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'BILLING_PROFILE_INVALID',
    message,
  });
}

function isValidRuc(value: string): boolean {
  if (!/^\d{13}$/.test(value) || !value.endsWith('001')) return false;
  const third = Number(value[2]);
  if (third <= 5) return isValidCedula(value.slice(0, 10));
  // Public entities (6) and legal entities (9): format only.
  return third === 6 || third === 9;
}

/** Validates an already normalized identification; throws 422 when invalid. */
export function assertValidTaxIdentification(
  idType: string,
  idNumber: string,
  legalName: string,
): void {
  if (idType !== '07' && idNumber === FINAL_CONSUMER_ID) {
    throw invalid('La identificación de consumidor final solo aplica al tipo 07');
  }

  switch (idType) {
    case '05':
      if (!isValidCedula(idNumber)) throw invalid('La cédula no es válida');
      return;
    case '04':
      if (!isValidRuc(idNumber)) throw invalid('El RUC no es válido');
      return;
    case '06':
      if (!/^[A-Z0-9]{3,20}$/.test(idNumber)) {
        throw invalid('El pasaporte no es válido');
      }
      return;
    case '07':
      if (
        idNumber !== FINAL_CONSUMER_ID ||
        legalName.trim().toUpperCase() !== FINAL_CONSUMER_NAME
      ) {
        throw invalid('El consumidor final debe usar 9999999999999 y el nombre CONSUMIDOR FINAL');
      }
      return;
    default:
      throw invalid('El tipo de identificación no es válido');
  }
}
