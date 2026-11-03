import { buildInvoiceXml, invoiceNumber, mainCode } from './invoice-xml';
import { sampleDocument } from './testing/sample-document';
import { validateInvoiceXsd } from './testing/xsd';

const EXPECTED =
  '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"><infoTributaria><ambiente>1</ambiente><tipoEmision>1</tipoEmision><razonSocial>Clínica Ejemplo S.A.</razonSocial><nombreComercial>Clínica Ejemplo</nombreComercial><ruc>1790012345001</ruc><claveAcceso>0710202601179001234500110010020000001231234567816</claveAcceso><codDoc>01</codDoc><estab>001</estab><ptoEmi>002</ptoEmi><secuencial>000000123</secuencial><dirMatriz>Av. Amazonas N1-23, Quito</dirMatriz><contribuyenteRimpe>CONTRIBUYENTE RÉGIMEN RIMPE</contribuyenteRimpe></infoTributaria><infoFactura><fechaEmision>07/10/2026</fechaEmision><dirEstablecimiento>Av. Amazonas N1-23, Quito</dirEstablecimiento><obligadoContabilidad>SI</obligadoContabilidad><tipoIdentificacionComprador>05</tipoIdentificacionComprador><razonSocialComprador>Juan Pérez &amp; Hijos</razonSocialComprador><identificacionComprador>1710034065</identificacionComprador><direccionComprador>Quito</direccionComprador><totalSinImpuestos>46.50</totalSinImpuestos><totalDescuento>0.50</totalDescuento><totalConImpuestos><totalImpuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje><baseImponible>40.00</baseImponible><valor>0.00</valor></totalImpuesto><totalImpuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><baseImponible>6.50</baseImponible><valor>0.98</valor></totalImpuesto></totalConImpuestos><propina>0.00</propina><importeTotal>47.48</importeTotal><moneda>DOLAR</moneda><pagos><pago><formaPago>01</formaPago><total>20.00</total></pago><pago><formaPago>19</formaPago><total>27.48</total></pago></pagos></infoFactura><detalles><detalle><codigoPrincipal>PSI-01</codigoPrincipal><descripcion>Sesión de psicoterapia</descripcion><cantidad>1.000000</cantidad><precioUnitario>40.000000</precioUnitario><descuento>0.00</descuento><precioTotalSinImpuesto>40.00</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje><tarifa>0.00</tarifa><baseImponible>40.00</baseImponible><valor>0.00</valor></impuesto></impuestos></detalle><detalle><codigoPrincipal>PRD-7</codigoPrincipal><descripcion>Cuaderno &lt;A5&gt;</descripcion><cantidad>2.000000</cantidad><precioUnitario>3.500000</precioUnitario><descuento>0.50</descuento><precioTotalSinImpuesto>6.50</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><tarifa>15.00</tarifa><baseImponible>6.50</baseImponible><valor>0.98</valor></impuesto></impuestos></detalle></detalles><infoAdicional><campoAdicional nombre="Email">juan@example.com</campoAdicional><campoAdicional nombre="Teléfono">0991234567</campoAdicional></infoAdicional></factura>';

describe('buildInvoiceXml', () => {
  it('writes the exact deterministic XML of InvoiceXmlBuilder.java', () => {
    expect(buildInvoiceXml(sampleDocument())).toBe(EXPECTED);
  });

  it('validates against factura_V1.1.0.xsd', async () => {
    expect(await validateInvoiceXsd(buildInvoiceXml(sampleDocument()))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('replaces characters XML 1.0 forbids and trims long text to 300', async () => {
    const xml = buildInvoiceXml(
      sampleDocument({
        customer: { ...sampleDocument().customer, name: 'A\u0001B' + 'x'.repeat(400) },
      }),
    );
    expect(xml).toContain(
      '<razonSocialComprador>A B' + 'x'.repeat(297) + '</razonSocialComprador>',
    );
    expect((await validateInvoiceXsd(xml)).valid).toBe(true);
  });

  it('omits optional fields and infoAdicional when empty', () => {
    const xml = buildInvoiceXml(
      sampleDocument({
        issuer: { ...sampleDocument().issuer, tradeName: null, rimpeRegime: 'NONE' },
        customer: { idType: '07', idNumber: '9999999999999', name: 'CONSUMIDOR FINAL' },
      }),
    );
    expect(xml).not.toContain('<nombreComercial>');
    expect(xml).not.toContain('<contribuyenteRimpe>');
    expect(xml).not.toContain('<infoAdicional>');
  });

  it('refuses the NEGOCIO_POPULAR regime, which the 1.1.0 XSD does not accept', () => {
    const doc = sampleDocument({
      issuer: { ...sampleDocument().issuer, rimpeRegime: 'NEGOCIO_POPULAR' },
    });
    expect(() => buildInvoiceXml(doc)).toThrow(
      expect.objectContaining({ kind: 'configuration', code: 'RIMPE_REGIME_UNSUPPORTED' }),
    );
  });

  it('derives a stable main code for lines without a treatment or product code', () => {
    expect(mainCode({ ...sampleDocument().lines[0], code: undefined, localId: 'item-1' })).toMatch(
      /^HCX-[0-9A-F]{8}$/,
    );
  });

  it('formats the invoice number', () => {
    expect(invoiceNumber(sampleDocument())).toBe('001-002-000000123');
  });
});
