import { Prisma } from '@prisma/client';
import { DocumentLineInput, SriError } from './sri-types';
import { ivaRateCode } from './tax-catalog';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export interface InvoiceTotals {
  lines: { subtotal: string; taxAmount: string; rateCode: string; rate: string }[];
  subtotal: string;
  totalDiscount: string;
  taxes: { rateCode: string; rate: string; base: string; amount: string }[];
  totalTax: string;
  total: string;
}

const invalidLine = () => new SriError('data', 'INVOICE_LINE_INVALID');

function money(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

function percentage(base: Decimal, rate: Decimal): Decimal {
  return money(base.mul(rate).div(100));
}

function parse(value: string | undefined): Decimal {
  try {
    const d = new Decimal(value as string);
    if (!d.isFinite()) throw invalidLine();
    return d;
  } catch {
    throw invalidLine();
  }
}

/**
 * Invoice totals per the SRI technical sheet: amounts carry two decimals
 * (half up) and the IVA of each rate is computed on the sum of that rate's
 * bases, not as the sum of the rounded line taxes.
 */
export function calculateInvoice(lines: DocumentLineInput[]): InvoiceTotals {
  if (!lines || lines.length === 0) throw invalidLine();

  const amounts: InvoiceTotals['lines'] = [];
  const rates = new Map<string, Decimal>();
  const bases = new Map<string, Decimal>();
  let subtotal = money(new Decimal(0));
  let totalDiscount = money(new Decimal(0));

  for (const line of lines) {
    const quantity = parse(line.quantity);
    const unitPrice = parse(line.unitPrice);
    const discount = parse(line.discount);
    const rate = parse(line.taxRatePercent);
    if (quantity.lte(0) || unitPrice.lt(0) || discount.lt(0) || rate.lt(0)) {
      throw invalidLine();
    }
    const gross = quantity.mul(unitPrice);
    if (discount.gt(gross)) throw invalidLine();

    const rateCode = ivaRateCode(line.taxRatePercent);
    const lineSubtotal = money(gross.sub(discount));
    amounts.push({
      subtotal: lineSubtotal.toFixed(2),
      taxAmount: percentage(lineSubtotal, rate).toFixed(2),
      rateCode,
      rate: rate.toFixed(2),
    });
    subtotal = subtotal.add(lineSubtotal);
    totalDiscount = totalDiscount.add(money(discount));
    if (!rates.has(rateCode)) rates.set(rateCode, rate);
    bases.set(rateCode, (bases.get(rateCode) ?? new Decimal(0)).add(lineSubtotal));
  }

  const taxes = [...bases.entries()]
    .map(([rateCode, base]) => {
      const rate = rates.get(rateCode) as Decimal;
      return { rateCode, rate, base, amount: percentage(base, rate) };
    })
    .sort((a, b) => Number(a.rateCode) - Number(b.rateCode));
  const totalTax = taxes.reduce((sum, t) => sum.add(t.amount), money(new Decimal(0)));

  return {
    lines: amounts,
    subtotal: subtotal.toFixed(2),
    totalDiscount: totalDiscount.toFixed(2),
    taxes: taxes.map((t) => ({
      rateCode: t.rateCode,
      rate: t.rate.toFixed(2),
      base: t.base.toFixed(2),
      amount: t.amount.toFixed(2),
    })),
    totalTax: totalTax.toFixed(2),
    total: subtotal.add(totalTax).toFixed(2),
  };
}
