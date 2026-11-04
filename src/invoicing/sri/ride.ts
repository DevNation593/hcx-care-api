import { Prisma } from '@prisma/client';
import { toBuffer } from 'bwip-js';
import PDFDocument from 'pdfkit';
import '../../common/pdf/standard-fonts';
import { printable } from '../../record-documents/record-pdf';
import { calculateInvoice } from './invoice-calculator';
import { RIMPE_LEGENDS, clean, invoiceNumber, mainCode } from './invoice-xml';
import { InvoiceDocument } from './sri-types';

/**
 * Printed representation (RIDE) of an authorized invoice, ported from the RideLayout and
 * RidePdfBuilder of the Java reference: issuer on the left; RUC, number, authorization and access
 * key with its barcode on the right; customer data; detail; totals on the right with the additional
 * information and payments below, and the closing legends. Every amount comes from
 * calculateInvoice, never recomputed here.
 */

export interface RideInput {
  document: InvoiceDocument;
  authorizationNumber: string;
  authorizedAt: Date;
}

export interface RideOptions {
  /** Defaults to true; tests turn it off to read the page streams. */
  compress?: boolean;
}

const Decimal = Prisma.Decimal;

const MARGIN = 28;
const GAP = 12;
const NAVY = '#28367F';
const PALE = '#EEF2F5';
const BAND_GREY = '#E0E4EA';
const RULE = '#D6DBE2';
const LINK = '#0000EE';
const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const SRI_VALIDATION_URL =
  'https://declaraciones.sri.gob.ec/comprobantes-electronicos-internet/publico/validezComprobantes.jsf';

const MAX_TEXT = 300;
const MAX_CODE = 25;
/** Rates whose subtotal / VAT row is always printed, even at zero. */
const FIXED_SUBTOTAL_RATES = ['15', '0', '5'];
const FIXED_VAT_RATES = ['15', '5'];

/** Table 24 of the SRI technical sheet; an unknown code prints as itself. */
const PAYMENT_NAMES: Record<string, string> = {
  '01': 'SIN UTILIZACION DEL SISTEMA FINANCIERO',
  '15': 'COMPENSACIÓN DE DEUDAS',
  '16': 'TARJETA DE DÉBITO',
  '17': 'DINERO ELECTRÓNICO',
  '18': 'TARJETA PREPAGO',
  '19': 'TARJETA DE CRÉDITO',
  '20': 'OTROS CON UTILIZACION DEL SISTEMA FINANCIERO',
  '21': 'ENDOSO DE TÍTULOS',
};

const ID_LABELS: Record<string, string> = {
  '04': 'RUC',
  '05': 'CÉDULA',
  '06': 'PASAPORTE',
};

/** The same text the XML carries (control characters and line breaks gone), in what Helvetica can show. */
function text(value: string | null | undefined, max = MAX_TEXT): string {
  return value ? printable(clean(value, max)).trim() : '';
}

/** At least `minScale` decimals, more when the value has them (unit prices carry up to six). */
function amount(value: string, minScale: number): string {
  const d = new Decimal(value);
  return d.toFixed(Math.max(minScale, d.decimalPlaces()));
}

function percent(rate: string): string {
  return new Decimal(rate).toString();
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Ecuador has no daylight saving: UTC-5 all year. */
function ecuadorDateTime(date: Date): string {
  const d = new Date(date.getTime() - 5 * 3600 * 1000);
  return (
    `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

function issueDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Subtotal rows by rate: 15 %, 0 %, 5 % always, then other rates, then not-subject and exempt. */
function subtotalRows(taxes: { rate: string; base: string }[]): [string, string][] {
  const bases = new Map<string, Prisma.Decimal>();
  for (const rate of FIXED_SUBTOTAL_RATES) bases.set(rate, new Decimal(0));
  for (const tax of taxes) {
    const key = percent(tax.rate);
    bases.set(key, (bases.get(key) ?? new Decimal(0)).plus(tax.base));
  }
  const rows: [string, string][] = [...bases].map(([rate, base]) => [
    `Subtotal IVA ${rate}%`,
    base.toFixed(2),
  ]);
  rows.push(['Subtotal No Objeto IVA', '0.00'], ['Subtotal Exento IVA', '0.00']);
  return rows;
}

/** VAT rows by rate: 15 % and 5 % always, other rates above zero after them. */
function vatRows(taxes: { rate: string; amount: string }[]): [string, string][] {
  const amounts = new Map<string, Prisma.Decimal>();
  for (const rate of FIXED_VAT_RATES) amounts.set(rate, new Decimal(0));
  for (const tax of taxes) {
    if (new Decimal(tax.rate).gt(0)) {
      const key = percent(tax.rate);
      amounts.set(key, (amounts.get(key) ?? new Decimal(0)).plus(tax.amount));
    }
  }
  return [...amounts].map(([rate, value]) => [`IVA ${rate}%`, value.toFixed(2)]);
}

class Page {
  y = MARGIN;
  readonly width: number;
  readonly bottom: number;

  constructor(readonly doc: PDFKit.PDFDocument) {
    this.width = doc.page.width - MARGIN * 2;
    this.bottom = doc.page.height - MARGIN;
  }

  /** Starts a new page when `height` does not fit in what is left; true when it did. */
  ensure(height: number): boolean {
    if (this.y + height <= this.bottom) return false;
    this.doc.addPage();
    this.y = MARGIN;
    return true;
  }

  height(value: string, width: number, font = REGULAR, size = 8): number {
    return this.doc.font(font).fontSize(size).heightOfString(value, { width });
  }

  /** A filled strip with centered text; returns its height. */
  band(
    x: number,
    y: number,
    width: number,
    value: string,
    fill: string,
    color: string,
    font: string,
    size: number,
  ): number {
    const h = this.height(value, width - 8, font, size) + 7;
    this.doc.rect(x, y, width, h).fill(fill);
    this.doc
      .fillColor(color)
      .font(font)
      .fontSize(size)
      .text(value, x + 4, y + 3, { width: width - 8, align: 'center' });
    this.doc
      .moveTo(x, y + h)
      .lineTo(x + width, y + h)
      .lineWidth(1)
      .strokeColor('white')
      .stroke();
    return h;
  }

  /** A pale row: bold label followed by the value. */
  labelled(x: number, y: number, width: number, label: string, value: string): number {
    const inner = width - 8;
    const h = this.height(label + value, inner, BOLD) + 5;
    this.doc.rect(x, y, width, h).fill(PALE);
    this.doc
      .moveTo(x, y + h)
      .lineTo(x + width, y + h)
      .lineWidth(1)
      .strokeColor('white')
      .stroke();
    this.doc.fillColor('black').font(BOLD).fontSize(8);
    this.doc.text(label, x + 4, y + 2.5, { width: inner, continued: value !== '' });
    if (value !== '') this.doc.font(REGULAR).text(value, { width: inner });
    return h;
  }

  /** One centered line (a long figure stays on it). */
  line(
    x: number,
    y: number,
    width: number,
    value: string,
    font = REGULAR,
    size = 8,
    color = 'black',
  ): number {
    this.doc.fillColor(color).font(font).fontSize(size);
    const h = this.doc.heightOfString(value, { width }) + 3;
    this.doc.text(value, x, y + 1.5, { width, align: 'center' });
    return h;
  }
}

function drawHeader(page: Page, input: RideInput, barcode: Buffer, number: string): void {
  const { doc } = page;
  const { document, authorizationNumber, authorizedAt } = input;
  const { issuer } = document;
  const leftW = (page.width - GAP) * 0.49;
  const rightW = page.width - GAP - leftW;
  const rightX = MARGIN + leftW + GAP;
  const top = page.y;

  // Issuer, in the place of the logo, which the issuer cannot upload.
  let y = top;
  const name = text(issuer.tradeName) || text(issuer.legalName);
  y += 14;
  y += page.line(MARGIN, y, leftW, name, BOLD, 15, NAVY);
  y += 14;
  const rows: [string, string][] = [
    ['RAZÓN SOCIAL: ', text(issuer.legalName)],
    ['NOMBRE COMERCIAL: ', text(issuer.tradeName)],
  ];
  const headOffice = text(issuer.headOfficeAddress);
  const branch = text(document.establishmentAddress);
  if (!branch || branch === headOffice) {
    rows.push(['DIRECCIÓN: ', headOffice]);
  } else {
    rows.push(['DIRECCIÓN MATRIZ: ', headOffice], ['DIRECCIÓN SUCURSAL: ', branch]);
  }
  rows.push(['OBLIGADO A LLEVAR CONTABILIDAD: ', issuer.accountingRequired ? 'SI' : 'NO']);
  if (issuer.specialTaxpayerCode) {
    rows.push(['CONTRIBUYENTE ESPECIAL NRO: ', text(issuer.specialTaxpayerCode)]);
  }
  if (issuer.withholdingAgentCode) {
    rows.push(['AGENTE DE RETENCIÓN RESOLUCIÓN NO. ', text(issuer.withholdingAgentCode)]);
  }
  const rimpe = RIMPE_LEGENDS[issuer.rimpeRegime];
  if (rimpe) rows.push([rimpe, '']);
  for (const [label, value] of rows) y += page.labelled(MARGIN, y, leftW, label, value);
  const leftBottom = y;

  // Fiscal box.
  y = top;
  y += page.band(rightX, y, rightW, `R.U.C. ${text(issuer.ruc)}`, NAVY, 'white', BOLD, 12);
  y += page.band(rightX, y, rightW, 'FACTURA', BAND_GREY, 'black', BOLD, 11);
  y += page.line(rightX, y, rightW, number);
  y += page.line(rightX, y, rightW, 'Número Autorización SRI');
  y += page.line(rightX, y, rightW, text(authorizationNumber), REGULAR, 7);
  const fiscal: [string, string][] = [
    ['FECHA Y HORA DE AUTORIZACIÓN: ', ecuadorDateTime(authorizedAt)],
    ['AMBIENTE: ', document.environment === '2' ? 'PRODUCCIÓN' : 'PRUEBAS'],
    ['ESTADO: ', 'AUTORIZADO'],
    ['EMISIÓN: ', 'NORMAL'],
  ];
  for (const [label, value] of fiscal) y += page.labelled(rightX, y, rightW, label, value);
  y += page.line(rightX, y, rightW, 'CLAVE DE ACCESO:', BOLD);
  doc.image(barcode, rightX + 4, y + 2, { fit: [rightW - 8, 32], align: 'center' });
  y += 36;
  y += page.line(rightX, y, rightW, text(document.accessKey), REGULAR, 7);

  page.y = Math.max(leftBottom, y) + 8;
}

function infoRowHeight(
  page: Page,
  width: number,
  labelWidth: number,
  [label, value]: [string, string],
): number {
  return (
    Math.max(
      page.height(label, labelWidth - 8, BOLD),
      page.height(value, width - labelWidth - 8, REGULAR),
    ) + 5
  );
}

/** Height drawInfoBlock will take, from the same measures it draws with. */
function measureInfoBlock(
  page: Page,
  width: number,
  title: string,
  rows: [string, string][],
  labelWidth: number,
): number {
  return (
    page.height(title, width - 8, BOLD, 8) +
    7 +
    rows.reduce((sum, row) => sum + infoRowHeight(page, width, labelWidth, row), 0)
  );
}

function drawInfoBlock(
  page: Page,
  x: number,
  width: number,
  title: string,
  rows: [string, string][],
  labelWidth: number,
): void {
  const { doc } = page;
  page.y += page.band(x, page.y, width, title, NAVY, 'white', BOLD, 8);
  for (const row of rows) {
    const [label, value] = row;
    const h = infoRowHeight(page, width, labelWidth, row);
    doc.rect(x, page.y, width, h).fill(PALE);
    doc
      .moveTo(x, page.y + h)
      .lineTo(x + width, page.y + h)
      .lineWidth(1)
      .strokeColor('white')
      .stroke();
    doc.fillColor('black').font(BOLD).fontSize(8);
    doc.text(label, x + 4, page.y + 2.5, { width: labelWidth - 8 });
    doc.font(REGULAR).text(value, x + labelWidth + 4, page.y + 2.5, {
      width: width - labelWidth - 8,
    });
    page.y += h;
  }
}

interface Column {
  title: string;
  width: number;
  align: 'left' | 'center' | 'right';
}

/** A table with a navy header repeated on every page; `rows` hold already printable text. */
function drawTable(page: Page, columns: Column[], rows: string[][]): void {
  const { doc } = page;
  const widths = columns.map((c) => c.width * page.width);
  const header = () => {
    let x = MARGIN;
    let h = 0;
    columns.forEach((column, i) => {
      h = Math.max(h, page.band(x, page.y, widths[i], column.title, NAVY, 'white', BOLD, 8));
      x += widths[i];
    });
    page.y += h;
  };
  header();
  for (const row of rows) {
    const h = Math.max(...row.map((cell, i) => page.height(cell, widths[i] - 6, REGULAR))) + 6;
    if (page.ensure(h + 1)) header();
    let x = MARGIN;
    doc.fillColor('black').font(REGULAR).fontSize(8);
    row.forEach((cell, i) => {
      doc.text(cell, x + 3, page.y + 3, { width: widths[i] - 6, align: columns[i].align });
      x += widths[i];
    });
    doc
      .moveTo(MARGIN, page.y + h)
      .lineTo(MARGIN + page.width, page.y + h)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
    page.y += h;
  }
}

function totalRow(
  page: Page,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  big: boolean,
): void {
  const { doc } = page;
  const labelW = width * 0.64;
  doc.rect(x, y, labelW, 16).fill(NAVY);
  doc
    .moveTo(x, y + 16)
    .lineTo(x + labelW, y + 16)
    .lineWidth(1)
    .strokeColor('white')
    .stroke();
  doc.fillColor('white').font(BOLD).fontSize(8);
  doc.text(label, x + 3, y + 4.5, { width: labelW - 6, align: 'right', lineBreak: false });
  doc
    .fillColor('black')
    .font(BOLD)
    .fontSize(big ? 10 : 9);
  doc.text(value, x + labelW + 3, y + (big ? 3.5 : 4), {
    width: width - labelW - 6,
    align: 'right',
    lineBreak: false,
  });
}

function drawFooter(
  page: Page,
  input: RideInput,
  totals: ReturnType<typeof calculateInvoice>,
): void {
  const { doc } = page;
  const { document } = input;
  const totalsW = page.width * 0.36;
  const totalsX = MARGIN + page.width - totalsW;

  const totalRows: [string, string][] = [
    ...subtotalRows(totals.taxes),
    ['Propina', '0.00'],
    ['Descuento', totals.totalDiscount],
    ...vatRows(totals.taxes),
  ];
  const customer = document.customer;
  const info: [string, string][] = [];
  if (customer.email) info.push(['Correo Electrónico', text(customer.email)]);
  if (customer.address) info.push(['Dirección', text(customer.address)]);
  info.push(['Teléfono', text(customer.phone)]);
  const payments = document.payments.map((p) => [
    PAYMENT_NAMES[p.methodCode] ?? text(p.methodCode),
    '',
    '',
    new Decimal(p.amount).toFixed(2),
  ]);
  const legal = `Favor remitir sus pagos y retenciones a nombre de "${text(document.issuer.legalName)}"`;

  // The closing block moves whole to the next page when it does not fit.
  const infoH = measureInfoBlock(
    page,
    page.width,
    'INFORMACIÓN ADICIONAL',
    info,
    page.width * 0.18,
  );
  const paymentsH = 15 + payments.length * 16;
  const legendsH = page.height(legal, page.width) + 4 * 12 + 14;
  const blockH =
    Math.max((totalRows.length + 1) * 16, 0) + 8 + infoH + 8 + paymentsH + 8 + legendsH + 4;
  page.ensure(blockH);

  let y = page.y;
  totalRows.forEach(([label, value], i) =>
    totalRow(page, totalsX, y + i * 16, totalsW, label, value, false),
  );
  const totalsBottom = y + totalRows.length * 16;
  totalRow(page, totalsX, totalsBottom, totalsW, 'TOTAL', totals.total, true);
  y = totalsBottom + 16 + 8;
  page.y = y;

  drawInfoBlock(page, MARGIN, page.width, 'INFORMACIÓN ADICIONAL', info, page.width * 0.18);
  page.y += 8;
  drawTable(
    page,
    [
      { title: 'FORMA DE PAGO', width: 0.64, align: 'left' },
      { title: 'PLAZO', width: 0.12, align: 'center' },
      { title: 'TIEMPO', width: 0.12, align: 'center' },
      { title: 'VALOR', width: 0.12, align: 'right' },
    ],
    payments,
  );
  page.y += 8;

  const centered = (value: string, font = REGULAR, size = 7, color = 'black', link?: string) => {
    doc.fillColor(color).font(font).fontSize(size);
    const options = {
      width: page.width,
      align: 'center' as const,
      ...(link ? { link, underline: true } : {}),
    };
    doc.text(value, MARGIN, page.y, options);
    page.y = doc.y + 3;
  };
  centered(legal, BOLD, 8);
  centered('Para verificar la validez y legalidad de sus comprobantes puede consultar en el SRI:');
  centered(SRI_VALIDATION_URL, REGULAR, 7, LINK, SRI_VALIDATION_URL);
  page.y += 5;
  centered('Cuidemos el medio ambiente.');
}

/** Renders the RIDE of an authorized invoice as an A4 PDF. */
export async function renderRide(input: RideInput, options: RideOptions = {}): Promise<Buffer> {
  const { document, authorizationNumber, authorizedAt } = input;
  if (!authorizationNumber?.trim() || !authorizedAt) {
    throw new Error('Only an authorized invoice has a RIDE');
  }
  const totals = calculateInvoice(document.lines);
  const number = invoiceNumber(document);
  const barcode = await toBuffer({
    bcid: 'code128',
    text: document.accessKey,
    scale: 2,
    height: 12,
  });

  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    compress: options.compress ?? true,
    info: { Title: `Factura ${number}`, Author: text(document.issuer.legalName) },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const page = new Page(doc);
  drawHeader(page, input, barcode, number);

  const customer = document.customer;
  drawInfoBlock(
    page,
    MARGIN,
    page.width,
    'DATOS DEL CLIENTE',
    [
      ['RAZÓN SOCIAL:', text(customer.name)],
      [`${ID_LABELS[customer.idType] ?? 'IDENTIFICACIÓN'}:`, text(customer.idNumber)],
      ['FECHA DE EMISIÓN:', issueDate(document.issueDate)],
    ],
    page.width * 0.18,
  );
  page.y += 8;

  drawTable(
    page,
    [
      { title: 'CÓDIGO', width: 0.13, align: 'left' },
      { title: 'CANTIDAD', width: 0.1, align: 'right' },
      { title: 'DESCRIPCIÓN', width: 0.51, align: 'left' },
      { title: 'V. UNITARIO', width: 0.13, align: 'right' },
      { title: 'V. TOTAL', width: 0.13, align: 'right' },
    ],
    document.lines.map((line, i) => [
      text(mainCode(line), MAX_CODE),
      amount(line.quantity, 2),
      text(line.name),
      amount(line.unitPrice, 2),
      totals.lines[i].subtotal,
    ]),
  );
  page.y += 8;

  drawFooter(page, input, totals);
  doc.end();
  return finished;
}
