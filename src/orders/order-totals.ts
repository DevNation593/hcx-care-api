import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface LineInput {
  quantity: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  discount: Prisma.Decimal.Value;
  taxRatePercent: Prisma.Decimal.Value;
}

export interface LineTotals {
  lineSubtotal: Prisma.Decimal;
  lineTax: Prisma.Decimal;
}

export interface OrderTotals {
  lines: LineTotals[];
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
}

export const SUPPORTED_FREE_TAX_RATES: readonly number[] = [0, 5, 15];

const D = Prisma.Decimal;

function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, D.ROUND_HALF_UP);
}

function invalidLine(message: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'ORDER_LINE_INVALID',
    message,
  });
}

export function computeOrderTotals(lines: LineInput[]): OrderTotals {
  const results: LineTotals[] = [];
  const subtotals: Prisma.Decimal[] = [];
  const rates: Prisma.Decimal[] = [];
  let discountTotal = new D(0);

  for (const input of lines) {
    const quantity = new D(input.quantity);
    const unitPrice = new D(input.unitPrice);
    const discount = new D(input.discount);
    const gross = quantity.mul(unitPrice);

    if (quantity.lte(0)) throw invalidLine('La cantidad debe ser mayor que cero');
    if (unitPrice.lt(0)) throw invalidLine('El precio unitario no puede ser negativo');
    if (discount.lt(0)) throw invalidLine('El descuento no puede ser negativo');
    if (discount.gt(gross)) {
      throw invalidLine('El descuento no puede superar el valor de la línea');
    }

    subtotals.push(round2(gross.sub(discount)));
    rates.push(new D(input.taxRatePercent));
    discountTotal = discountTotal.add(discount);
  }

  // Tax is computed on the sum per rate; the last line of each rate absorbs the rounding difference.
  const lineTaxes: Prisma.Decimal[] = subtotals.map((subtotal, i) =>
    round2(subtotal.mul(rates[i]).div(100)),
  );
  const byRate = new Map<string, number[]>();
  rates.forEach((rate, i) => {
    const key = rate.toString();
    byRate.set(key, [...(byRate.get(key) ?? []), i]);
  });

  let taxTotal = new D(0);
  for (const indexes of byRate.values()) {
    const base = indexes.reduce((acc, i) => acc.add(subtotals[i]), new D(0));
    const rate = rates[indexes[0]];
    const rateTax = round2(base.mul(rate).div(100));
    const last = indexes[indexes.length - 1];
    const others = indexes.slice(0, -1).reduce((acc, i) => acc.add(lineTaxes[i]), new D(0));
    lineTaxes[last] = rateTax.sub(others);
    taxTotal = taxTotal.add(rateTax);
  }

  subtotals.forEach((lineSubtotal, i) => results.push({ lineSubtotal, lineTax: lineTaxes[i] }));

  const subtotal = subtotals.reduce((acc, s) => acc.add(s), new D(0));
  return {
    lines: results,
    subtotal,
    discountTotal,
    taxTotal,
    total: subtotal.add(taxTotal),
  };
}
