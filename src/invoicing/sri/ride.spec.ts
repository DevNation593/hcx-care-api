import { renderRide } from './ride';
import { sampleDocument } from './testing/sample-document';

const AUTHORIZED_AT = new Date('2026-10-07T15:20:00Z');

/**
 * Text drawn on the pages of an uncompressed pdfkit file. Standard fonts are written as hex
 * strings in WinAnsi, which for the characters used here is Latin-1.
 */
function pdfText(pdf: Buffer): string {
  const source = pdf.toString('latin1');
  const hex = (chunk: string) =>
    [...chunk.matchAll(/<([0-9a-fA-F]+)>/g)]
      .map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
      .join('');
  const lines: string[] = [];
  for (const m of source.matchAll(/\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g)) {
    lines.push(m[1] !== undefined ? hex(m[1]) : hex(`<${m[2]}>`));
  }
  // A label and its value are drawn as two runs; read them as one line.
  return lines.join('\n').replace(/: \n/g, ': ');
}

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

/** Text of each page: the content streams of an uncompressed file, in page order. */
function pageTexts(pdf: Buffer): string[] {
  return pdf
    .toString('latin1')
    .split('endstream')
    .filter((chunk) => chunk.includes(' Tj') || chunk.includes(' TJ'))
    .map((chunk) => pdfText(Buffer.from(chunk, 'latin1')));
}

async function render(document = sampleDocument(), authorizedAt = AUTHORIZED_AT) {
  return renderRide(
    { document, authorizationNumber: document.accessKey, authorizedAt },
    { compress: false },
  );
}

describe('renderRide', () => {
  it('renders a PDF with the access key, number and totals', async () => {
    const pdf = await render();

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(pdf);
    expect(text).toContain('001-002-000000123');
    expect(text).toContain('0710202601179001234500110010020000001231234567816');
    expect(text).toContain('47.48');
    expect(text).toContain('CONTRIBUYENTE RÉGIMEN RIMPE');
    expect(text).toContain('PRUEBAS');
  });

  it('prints the sections and labels of the invoice', async () => {
    const text = pdfText(await render());

    for (const expected of [
      'R.U.C. 1790012345001',
      'FACTURA',
      'Número Autorización SRI',
      'FECHA Y HORA DE AUTORIZACIÓN: 07/10/2026 10:20:00',
      'AMBIENTE: PRUEBAS',
      'ESTADO: AUTORIZADO',
      'EMISIÓN: NORMAL',
      'CLAVE DE ACCESO:',
      'RAZÓN SOCIAL: Clínica Ejemplo S.A.',
      'NOMBRE COMERCIAL: Clínica Ejemplo',
      'DIRECCIÓN: Av. Amazonas N1-23, Quito',
      'OBLIGADO A LLEVAR CONTABILIDAD: SI',
      'DATOS DEL CLIENTE',
      'CÉDULA:',
      '1710034065',
      'FECHA DE EMISIÓN:',
      '07/10/2026',
      'Juan Pérez & Hijos',
      'CÓDIGO',
      'CANTIDAD',
      'V. UNITARIO',
      'PSI-01',
      'Cuaderno <A5>',
      '40.00',
      '6.50',
      'Subtotal IVA 15%',
      'Subtotal IVA 0%',
      'Subtotal IVA 5%',
      'Subtotal No Objeto IVA',
      'Subtotal Exento IVA',
      'Propina',
      'Descuento',
      'IVA 15%',
      '0.98',
      'TOTAL',
      'INFORMACIÓN ADICIONAL',
      'juan@example.com',
      'FORMA DE PAGO',
      'SIN UTILIZACION DEL SISTEMA FINANCIERO',
      'TARJETA DE CRÉDITO',
      '27.48',
      'Cuidemos el medio ambiente.',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('labels the production environment and omits the RIMPE legend when there is none', async () => {
    const base = sampleDocument();
    const text = pdfText(
      await render(
        sampleDocument({
          environment: '2',
          issuer: { ...base.issuer, rimpeRegime: 'NONE' },
        }),
      ),
    );

    expect(text).toContain('PRODUCCIÓN');
    expect(text).not.toContain('PRUEBAS');
    expect(text).not.toContain('RIMPE');
  });

  it('separates the branch address from the head office when they differ', async () => {
    const text = pdfText(
      await render(sampleDocument({ establishmentAddress: 'Calle Sucursal 5' })),
    );

    expect(text).toContain('DIRECCIÓN MATRIZ: Av. Amazonas N1-23, Quito');
    expect(text).toContain('DIRECCIÓN SUCURSAL: Calle Sucursal 5');
  });

  it('never prints characters the XML strips', async () => {
    const base = sampleDocument();
    const text = pdfText(
      await render(
        sampleDocument({
          customer: { ...base.customer, name: 'Ana\u0001 Soto\u2028Ruiz' },
        }),
      ),
    );

    expect(text).toContain('Ana  Soto Ruiz');
    expect(text).not.toMatch(/[\u0001\u2028]/);
  });

  it('renders many lines across pages', async () => {
    const base = sampleDocument();
    const lines = Array.from({ length: 80 }, (_, i) => ({
      ...base.lines[0],
      localId: `l${i}`,
      code: `COD-${i}`,
    }));
    const document = sampleDocument({ lines, payments: [{ methodCode: '01', amount: '3200.00' }] });

    const pdf = await render(document);

    expect(pageCount(pdf)).toBeGreaterThanOrEqual(2);
    const text = pdfText(pdf);
    expect(text).toContain('COD-79');
    expect(text).toContain('3200.00');
  });

  it('keeps the whole footer on one page wherever it lands', async () => {
    const base = sampleDocument();
    const address = 'Calle de los Almendros y Avenida Larga '.repeat(8).slice(0, 300);
    for (let count = 1; count <= 60; count++) {
      const lines = Array.from({ length: count }, (_, i) => ({
        ...base.lines[0],
        localId: `l${i}`,
        code: `COD-${i}`,
      }));
      const document = sampleDocument({
        lines,
        customer: { ...base.customer, address, email: `${'a'.repeat(200)}@example.com` },
        payments: [{ methodCode: '01', amount: (count * 40).toFixed(2) }],
      });

      const pdf = await render(document);
      const pages = pageTexts(pdf);

      // pdfkit never added a page of its own: every page has content and the counts agree.
      expect(pages).toHaveLength(pageCount(pdf));
      const footerPages = pages.filter((p) => p.includes('INFORMACIÓN ADICIONAL'));
      expect(footerPages).toHaveLength(1);
      expect(footerPages[0]).toContain('FORMA DE PAGO');
      expect(footerPages[0]).toContain('validezComprobantes.jsf');
      expect(footerPages[0]).toContain('Cuidemos el medio ambiente.');
      expect(footerPages[0]).toContain('TOTAL');
    }
  });

  it('compresses by default', async () => {
    const document = sampleDocument();
    const pdf = await renderRide({
      document,
      authorizationNumber: document.accessKey,
      authorizedAt: AUTHORIZED_AT,
    });

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdfText(pdf)).not.toContain('001-002-000000123');
  });
});
