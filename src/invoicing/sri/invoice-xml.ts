import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { calculateInvoice } from './invoice-calculator';
import { DocumentLineInput, InvoiceDocument, RimpeRegime, SriError } from './sri-types';
import { IVA_TAX_CODE } from './tax-catalog';

const MAX_TEXT = 300;
const MAX_CODE = 25;

/**
 * Annex 22 of the SRI technical sheet. NEGOCIO_POPULAR is refused: the 1.1.0 XSD only
 * accepts the EMPRENDEDOR legend in contribuyenteRimpe.
 */
export const RIMPE_LEGENDS: Partial<Record<RimpeRegime, string | null>> = {
  NONE: null,
  EMPRENDEDOR: 'CONTRIBUYENTE RÉGIMEN RIMPE',
};

function allowedInXml(c: number): boolean {
  return (
    c === 0x9 ||
    c === 0xa ||
    c === 0xd ||
    (c >= 0x20 && c <= 0xd7ff) ||
    (c >= 0xe000 && c <= 0xfffd) ||
    (c >= 0x10000 && c <= 0x10ffff)
  );
}

/**
 * Line breaks (including U+0085, U+2028, U+2029, which XML 1.1 parsers turn into LF) and tabs:
 * many XSD text fields have pattern="[^\n]*".
 */
const LINE_BREAK_OR_TAB = /[\t\n\r\u0085\u2028\u2029]/;

/**
 * Replaces characters XML 1.0 forbids, line breaks and tabs with a space and trims to `max`
 * code points.
 */
export function clean(value: string, max: number): string {
  const chars = Array.from(value, (ch) =>
    allowedInXml(ch.codePointAt(0) as number) && !LINE_BREAK_OR_TAB.test(ch) ? ch : ' ',
  );
  return chars.slice(0, max).join('');
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function present(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== '';
}

function scaled(value: string, scale: number): string {
  return new Prisma.Decimal(value).toFixed(scale, Prisma.Decimal.ROUND_HALF_UP);
}

function sriDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new SriError('data', 'ISSUE_DATE_INVALID');
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function invoiceNumber(
  doc: Pick<InvoiceDocument, 'establishmentCode' | 'emissionPointCode' | 'sequential'>,
): string {
  return `${doc.establishmentCode}-${doc.emissionPointCode}-${String(doc.sequential).padStart(9, '0')}`;
}

/** Principal code of a line: its own code, or a stable one derived from its local id. */
export function mainCode(line: DocumentLineInput): string {
  if (present(line.code)) return line.code;
  return 'HCX-' + createHash('sha256').update(line.localId).digest('hex').slice(0, 8).toUpperCase();
}

class XmlWriter {
  private out = '<?xml version="1.0" encoding="UTF-8"?>';

  raw(value: string): void {
    this.out += value;
  }

  open(name: string): void {
    this.out += `<${name}>`;
  }

  close(name: string): void {
    this.out += `</${name}>`;
  }

  /** Element with a short value (codes, amounts, dates). */
  element(name: string, value: string, max = MAX_TEXT): void {
    this.out += `<${name}>${escape(clean(value, max))}</${name}>`;
  }

  optional(name: string, value: string | null | undefined, max = MAX_TEXT): void {
    if (present(value)) this.element(name, value, max);
  }

  toString(): string {
    return this.out;
  }
}

export function buildInvoiceXml(doc: InvoiceDocument): string {
  const totals = calculateInvoice(doc.lines);
  const w = new XmlWriter();
  const { issuer, customer } = doc;

  w.raw('<factura id="comprobante" version="1.1.0">');

  w.open('infoTributaria');
  w.element('ambiente', doc.environment);
  w.element('tipoEmision', '1');
  w.element('razonSocial', issuer.legalName);
  w.optional('nombreComercial', issuer.tradeName);
  w.element('ruc', issuer.ruc);
  w.element('claveAcceso', doc.accessKey);
  w.element('codDoc', '01');
  w.element('estab', doc.establishmentCode);
  w.element('ptoEmi', doc.emissionPointCode);
  w.element('secuencial', String(doc.sequential).padStart(9, '0'));
  w.element('dirMatriz', issuer.headOfficeAddress);
  w.optional('agenteRetencion', issuer.withholdingAgentCode);
  const legend = RIMPE_LEGENDS[issuer.rimpeRegime];
  if (issuer.rimpeRegime === 'NEGOCIO_POPULAR') {
    throw new SriError('configuration', 'RIMPE_REGIME_UNSUPPORTED');
  }
  if (legend === undefined) throw new SriError('configuration', 'RIMPE_REGIME_UNKNOWN');
  w.optional('contribuyenteRimpe', legend);
  w.close('infoTributaria');

  w.open('infoFactura');
  w.element('fechaEmision', sriDate(doc.issueDate));
  w.optional('dirEstablecimiento', doc.establishmentAddress);
  w.optional('contribuyenteEspecial', issuer.specialTaxpayerCode);
  w.element('obligadoContabilidad', issuer.accountingRequired ? 'SI' : 'NO');
  w.element('tipoIdentificacionComprador', customer.idType);
  w.element('razonSocialComprador', customer.name);
  w.element('identificacionComprador', customer.idNumber);
  w.optional('direccionComprador', customer.address);
  w.element('totalSinImpuestos', totals.subtotal);
  w.element('totalDescuento', totals.totalDiscount);
  w.open('totalConImpuestos');
  for (const tax of totals.taxes) {
    w.open('totalImpuesto');
    w.element('codigo', IVA_TAX_CODE);
    w.element('codigoPorcentaje', tax.rateCode);
    w.element('baseImponible', tax.base);
    w.element('valor', tax.amount);
    w.close('totalImpuesto');
  }
  w.close('totalConImpuestos');
  w.element('propina', '0.00');
  w.element('importeTotal', totals.total);
  w.element('moneda', 'DOLAR');
  w.open('pagos');
  for (const payment of doc.payments) {
    w.open('pago');
    w.element('formaPago', payment.methodCode);
    w.element('total', scaled(payment.amount, 2));
    w.close('pago');
  }
  w.close('pagos');
  w.close('infoFactura');

  w.open('detalles');
  doc.lines.forEach((line, i) => {
    const amounts = totals.lines[i];
    w.open('detalle');
    w.element('codigoPrincipal', mainCode(line), MAX_CODE);
    w.element('descripcion', line.name);
    w.element('cantidad', scaled(line.quantity, 6));
    w.element('precioUnitario', scaled(line.unitPrice, 6));
    w.element('descuento', scaled(line.discount, 2));
    w.element('precioTotalSinImpuesto', amounts.subtotal);
    w.open('impuestos');
    w.open('impuesto');
    w.element('codigo', IVA_TAX_CODE);
    w.element('codigoPorcentaje', amounts.rateCode);
    w.element('tarifa', amounts.rate);
    w.element('baseImponible', amounts.subtotal);
    w.element('valor', amounts.taxAmount);
    w.close('impuesto');
    w.close('impuestos');
    w.close('detalle');
  });
  w.close('detalles');

  const extras: [string, string][] = [];
  if (present(customer.email)) extras.push(['Email', customer.email]);
  if (present(customer.phone)) extras.push(['Teléfono', customer.phone]);
  if (extras.length > 0) {
    w.open('infoAdicional');
    for (const [name, value] of extras) {
      w.raw(`<campoAdicional nombre="${name}">${escape(clean(value, MAX_TEXT))}</campoAdicional>`);
    }
    w.close('infoAdicional');
  }

  w.close('factura');
  return w.toString();
}
