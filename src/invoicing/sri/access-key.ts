import { randomInt } from 'crypto';
import { SriEnvironment } from './sri-types';

const INVOICE_DOC_CODE = '01';
const NORMAL_EMISSION = '1';

export interface AccessKeyParts {
  /** YYYY-MM-DD */
  issueDate: string;
  ruc: string;
  environment: SriEnvironment;
  establishmentCode: string;
  emissionPointCode: string;
  sequential: number;
  numericCode: string;
}

function mod11CheckDigit(base48: string): number {
  let sum = 0;
  let factor = 2;
  for (let i = base48.length - 1; i >= 0; i--) {
    sum += Number(base48[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const dv = 11 - (sum % 11);
  if (dv === 11) return 0;
  if (dv === 10) return 1;
  return dv;
}

function requireDigits(value: string, length: number, label: string): void {
  if (!new RegExp(`^\\d{${length}}$`).test(value)) {
    throw new Error(`${label} must be exactly ${length} digits`);
  }
}

/** 49-digit access key with its mod-11 check digit (invoice, normal emission). */
export function buildAccessKey(p: AccessKeyParts): string {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(p.issueDate);
  if (!date) throw new Error('issueDate must be YYYY-MM-DD');
  requireDigits(p.ruc, 13, 'ruc');
  requireDigits(p.establishmentCode, 3, 'establishmentCode');
  requireDigits(p.emissionPointCode, 3, 'emissionPointCode');
  requireDigits(p.numericCode, 8, 'numericCode');
  if (p.environment !== '1' && p.environment !== '2') {
    throw new Error('environment must be 1 or 2');
  }
  if (!Number.isInteger(p.sequential) || p.sequential < 1 || p.sequential > 999_999_999) {
    throw new Error('sequential must be an integer between 1 and 999999999');
  }
  const base48 =
    `${date[3]}${date[2]}${date[1]}` +
    INVOICE_DOC_CODE +
    p.ruc +
    p.environment +
    p.establishmentCode +
    p.emissionPointCode +
    String(p.sequential).padStart(9, '0') +
    p.numericCode +
    NORMAL_EMISSION;
  return base48 + mod11CheckDigit(base48);
}

export function isValidAccessKey(key: string): boolean {
  return (
    typeof key === 'string' &&
    /^\d{49}$/.test(key) &&
    mod11CheckDigit(key.slice(0, 48)) === Number(key[48])
  );
}

export function newNumericCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0');
}
