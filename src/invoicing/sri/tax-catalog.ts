import { Prisma } from '@prisma/client';
import { SriError } from './sri-types';

/** SRI tax code for IVA. */
export const IVA_TAX_CODE = '2';

/** IVA percentage (normalised to two decimals) to SRI rate code. */
const IVA_RATE_CODES: Record<string, string> = {
  '0.00': '0',
  '5.00': '5',
  '12.00': '2',
  '13.00': '10',
  '14.00': '3',
  '15.00': '4',
};

export function ivaRateCode(percent: string): string {
  let key: string;
  try {
    key = new Prisma.Decimal(percent).toFixed(2);
  } catch {
    throw new SriError('data', 'TAX_RATE_UNSUPPORTED');
  }
  const code = IVA_RATE_CODES[key];
  if (code === undefined) throw new SriError('data', 'TAX_RATE_UNSUPPORTED');
  return code;
}
