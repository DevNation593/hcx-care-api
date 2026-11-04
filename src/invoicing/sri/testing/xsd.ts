import { readFileSync } from 'fs';
import { join } from 'path';
import { validateXML } from 'xmllint-wasm';

const XSD_DIR = join(__dirname, '..', '..', '..', '..', 'test', 'fixtures', 'sri', 'xsd');

let schemas: { invoice: string; dsig: string } | undefined;

function loadSchemas() {
  schemas ??= {
    invoice: readFileSync(join(XSD_DIR, 'factura_V1.1.0.xsd'), 'utf8'),
    dsig: readFileSync(join(XSD_DIR, 'xmldsig-core-schema.xsd'), 'utf8'),
  };
  return schemas;
}

/** Validates an invoice XML against the SRI factura 1.1.0 schema. */
export async function validateInvoiceXsd(
  xml: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const { invoice, dsig } = loadSchemas();
  const result = await validateXML({
    xml: { fileName: 'invoice.xml', contents: xml },
    schema: { fileName: 'factura_V1.1.0.xsd', contents: invoice },
    preload: [{ fileName: 'xmldsig-core-schema.xsd', contents: dsig }],
  });
  return { valid: result.valid, errors: result.errors.map((e) => e.rawMessage) };
}
