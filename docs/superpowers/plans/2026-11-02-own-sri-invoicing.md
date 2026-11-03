# Facturador electrónico propio — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HCX emite facturas electrónicas directamente al SRI (firma XAdES-BES, SOAP offline, RIDE, correo) y deja de depender de Emite Fácil.

**Architecture:** Funciones puras en `api/src/invoicing/sri/` (clave de acceso, cálculo, XML, certificado, firma, cliente SOAP, RIDE), portadas del Java de `D:/Proyectos Personales/backend-emite-facil`. Un `InvoiceEmitter` avanza cada `InvoiceRequest` por pasos persistidos (preflight → firma → recepción → autorización → artefactos → correo) bajo los leases del worker actual. El worker se dispara inline al solicitar la factura y desde un endpoint de tick con secreto. Primero se agrega lo nuevo junto a lo viejo (migración aditiva) y al final se elimina Emite Fácil (migración de borrado), para que cada tarea compile y pase pruebas.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), Jest, `node-forge`, `@xmldom/xmldom`, `xml-crypto`, `pdfkit`, `bwip-js`, `xmllint-wasm` (dev). Web: Next.js, React Query, Vitest.

**Spec:** `api/docs/superpowers/specs/2026-11-02-own-sri-invoicing-design.md`

## Global Constraints

- Solo factura `codDoc 01`, XSD `1.1.0`, tipo de emisión `1`. Nada de nota de crédito, retenciones ni contingencia.
- Hosts SRI permitidos: `celcer.sri.gob.ec` (ambiente `1`) y `cel.sri.gob.ec` (ambiente `2`), rutas `/comprobantes-electronicos-ws/RecepcionComprobantesOffline` y `/comprobantes-electronicos-ws/AutorizacionComprobantesOffline`. Sin redirecciones. Única excepción: `SRI_TEST_BASE_URL` cuando `NODE_ENV === 'test'`.
- Firma: C14N inclusiva (`http://www.w3.org/TR/2001/REC-xml-c14n-20010315`), `rsa-sha1`, digest `sha1`, tres referencias, `SigningTime` en `-05:00` truncado a segundos.
- Nunca registrar en logs, auditoría ni `SriError` el `.p12`, su contraseña ni textos del SRI. Mensajes del SRI solo en `lastErrorEncrypted`.
- Desde que una solicitud tiene `signedXmlStorageKey`, nunca pasa a `FAILED`, nunca recibe otro secuencial ni otra clave, y todo reenvío usa los bytes guardados (SHA-256 verificado).
- Decimales como `string` o `Prisma.Decimal`, redondeo `ROUND_HALF_UP`; dinero con 2 decimales, cantidad y precio unitario con 6 en el XML.
- Fecha fiscal en UTC-5 (Ecuador no tiene horario de verano).
- Archivos del repo son CRLF: editar con la herramienta Edit, no con parches de texto con `\n`.
- `npm run lint` de `api/` no arranca (T-15); usar `npx prettier --check <archivos>`.
- PRs contra `dev` en `api/` y en `web/`. Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Textos para el usuario en español; código y comentarios siguen el estilo del archivo vecino (inglés en `api/src`).

## Review Focus

1. Consumidor final (`idType 07`) con total mayor a USD 50: el SRI lo rechaza. Se espera `422 FINAL_CONSUMER_LIMIT` al solicitar, sin marcar la orden como facturada. → Task 8.
2. Nombres, descripciones o direcciones con caracteres de control, `&`, `<`, comillas o más de 300 caracteres: se espera XML válido contra la XSD (caracteres no admitidos por XML 1.0 reemplazados por espacio, texto recortado a 300), nunca una excepción que deje la fila en reintento infinito. → Task 2.
3. `.p12` reales de Security Data/BCE (cifrado 3DES o RC2 heredado, cadena con varios certificados) y `.p12` de OpenSSL 3 (AES-256): se espera que abran y que se elija el certificado que corresponde a la clave privada. → Task 3.
4. Dos facturas simultáneas en el mismo punto de emisión (inline y tick, o dos cajeros): se espera secuenciales distintos y consecutivos y un solo lease por fila. → Tasks 8 y 13.
5. Tick sin `INVOICING_TICK_SECRET` configurado, con cabecera vacía o con secreto de distinta longitud: se espera 404 / 401 sin excepción de `timingSafeEqual`. → Task 11.

---

### Task 0: Ramas de trabajo

**Files:** ninguno.

- [ ] **Step 1: Rama de la API.** El checkout de `api/` está limpio (rama `qa`) y la spec y este plan están sin seguimiento.

```bash
cd "D:/Proyectos Personales/Saas - Psic/api"
git fetch origin
git switch -c feat/own-sri-invoicing origin/dev
git add docs/superpowers/specs/2026-11-02-own-sri-invoicing-design.md docs/superpowers/plans/2026-11-02-own-sri-invoicing.md
git commit -m "docs(invoicing): spec and plan for the own SRI invoicer"
```

- [ ] **Step 2: Worktree de la web.** `web/` tiene cambios sin commit en `feat/plan-ladder`; no se tocan.

```bash
cd "D:/Proyectos Personales/Saas - Psic/web"
git fetch origin
git worktree add .worktrees/own-sri-invoicing -b feat/own-sri-invoicing origin/dev
cd .worktrees/own-sri-invoicing && npm ci
```

Expected: `npx prisma generate` en `api/` y `npm test -- --run` en el worktree web corren sin errores antes de empezar.

---

### Task 1: Tipos SRI, clave de acceso, catálogo de IVA y cálculo

**Files:**
- Modify: `api/package.json` (deps `node-forge`, `@xmldom/xmldom`, `xml-crypto`, `bwip-js`; dev `@types/node-forge`, `xmllint-wasm`)
- Create: `api/src/invoicing/sri/sri-types.ts`, `access-key.ts`, `tax-catalog.ts`, `invoice-calculator.ts`
- Test: `api/src/invoicing/sri/access-key.spec.ts`, `invoice-calculator.spec.ts`

**Interfaces:**
- Produces (`sri-types.ts`):
  ```ts
  export type SriEnvironment = '1' | '2';
  export type RimpeRegime = 'NONE' | 'EMPRENDEDOR' | 'NEGOCIO_POPULAR';
  export interface IssuerSnapshot { ruc: string; legalName: string; tradeName: string | null; headOfficeAddress: string; accountingRequired: boolean; specialTaxpayerCode: string | null; withholdingAgentCode: string | null; rimpeRegime: RimpeRegime }
  export interface CustomerProfile { idType: string; idNumber: string; name: string; email?: string | null; address?: string | null; phone?: string | null }
  export interface Payment { methodCode: string; amount: string }
  export interface DocumentLineInput { localId: string; code?: string; name: string; quantity: string; unitPrice: string; discount: string; taxRatePercent: string }
  export interface InvoiceDocument { environment: SriEnvironment; issuer: IssuerSnapshot; establishmentCode: string; emissionPointCode: string; establishmentAddress: string; sequential: number; accessKey: string; issueDate: string /* YYYY-MM-DD */; customer: CustomerProfile; lines: DocumentLineInput[]; payments: Payment[] }
  export interface SriMessage { identifier: string | null; message: string | null; additionalInfo: string | null; type: string | null }
  export type SriErrorKind = 'transient' | 'data' | 'configuration';
  export class SriError extends Error { constructor(readonly kind: SriErrorKind, readonly code: string, metadata?: { status?: number; retryAfterMs?: number }); readonly status?: number; readonly retryAfterMs?: number }
  ```
- Produces: `buildAccessKey(p: { issueDate: string; ruc: string; environment: SriEnvironment; establishmentCode: string; emissionPointCode: string; sequential: number; numericCode: string }): string`, `isValidAccessKey(key: string): boolean`, `newNumericCode(): string` (8 dígitos con `crypto.randomInt`).
- Produces: `IVA_TAX_CODE = '2'`, `ivaRateCode(percent: string): string` (lanza `SriError('data', 'TAX_RATE_UNSUPPORTED')`).
- Produces: `calculateInvoice(lines: DocumentLineInput[]): InvoiceTotals` con `InvoiceTotals = { lines: { subtotal: string; taxAmount: string; rateCode: string; rate: string }[]; subtotal: string; totalDiscount: string; taxes: { rateCode: string; rate: string; base: string; amount: string }[]; totalTax: string; total: string }`.

- [ ] **Step 1: Instalar dependencias**

```bash
cd "D:/Proyectos Personales/Saas - Psic/api"
npm install node-forge @xmldom/xmldom xml-crypto bwip-js
npm install -D @types/node-forge xmllint-wasm
```

- [ ] **Step 2: Escribir las pruebas que fallan**

`access-key.spec.ts` (vectores de `backend-emite-facil/src/test/java/.../sequence/AccessKey*Test.java`):

```ts
it('builds the 49-digit key with its mod-11 check digit', () => {
  expect(buildAccessKey({ issueDate: '2026-10-07', ruc: '1790012345001', environment: '1', establishmentCode: '001', emissionPointCode: '002', sequential: 123, numericCode: '12345678' }))
    .toBe('0710202601179001234500110010020000001231234567816');
});
it('validates keys', () => {
  expect(isValidAccessKey('0710202601179001234500110010020000001231234567816')).toBe(true);
  expect(isValidAccessKey('0710202601179001234500110010020000001231234567817')).toBe(false);
  expect(isValidAccessKey('0710202601179001234500110010020000001241234567816')).toBe(false);
});
it('maps a remainder of 11 to 0 and of 10 to 1', () => { /* recorrer secuenciales 1..200 con el mismo resto y comprobar que todo dígito está en 0..9 y que isValidAccessKey es true */ });
it('rejects malformed parts', () => {
  expect(() => buildAccessKey({ ...base, establishmentCode: '1' })).toThrow();
  expect(() => buildAccessKey({ ...base, sequential: 1_000_000_000 })).toThrow();
});
it('creates 8-digit numeric codes', () => expect(newNumericCode()).toMatch(/^\d{8}$/));
```

`invoice-calculator.spec.ts`:

```ts
const lines = [
  { localId: 'a', code: 'PSI-01', name: 'Sesión de psicoterapia', quantity: '1.000000', unitPrice: '40.00', discount: '0.00', taxRatePercent: '0.00' },
  { localId: 'b', code: 'PRD-7', name: 'Cuaderno <A5>', quantity: '2.000000', unitPrice: '3.50', discount: '0.50', taxRatePercent: '15.00' },
];
it('rounds each line and taxes per rate like InvoiceCalculator.java', () => {
  expect(calculateInvoice(lines)).toEqual({
    lines: [
      { subtotal: '40.00', taxAmount: '0.00', rateCode: '0', rate: '0.00' },
      { subtotal: '6.50', taxAmount: '0.98', rateCode: '4', rate: '15.00' },
    ],
    subtotal: '46.50', totalDiscount: '0.50',
    taxes: [ { rateCode: '0', rate: '0.00', base: '40.00', amount: '0.00' }, { rateCode: '4', rate: '15.00', base: '6.50', amount: '0.98' } ],
    totalTax: '0.98', total: '47.48',
  });
});
it('taxes the rate base, not the sum of rounded line taxes', () => {
  // tres líneas de 0.10 al 15 %: cada línea 0.02 (0.015 → 0.02), base 0.30 → IVA 0.05 (0.045 → 0.05)
  const t = calculateInvoice([1, 2, 3].map((i) => ({ ...lines[1], localId: String(i), quantity: '1', unitPrice: '0.10', discount: '0.00' })));
  expect(t.taxes).toEqual([{ rateCode: '4', rate: '15.00', base: '0.30', amount: '0.05' }]);
});
it('maps SRI IVA rate codes', () => {
  expect(['0', '5', '12', '13', '14', '15'].map((p) => ivaRateCode(p + '.00'))).toEqual(['0', '5', '2', '10', '3', '4']);
  expect(() => ivaRateCode('7.00')).toThrow(expect.objectContaining({ kind: 'data', code: 'TAX_RATE_UNSUPPORTED' }));
});
```

- [ ] **Step 3: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing/sri`
Expected: FAIL con "Cannot find module './access-key'".

- [ ] **Step 4: Implementar** `sri-types.ts`, `access-key.ts` (port de `sequence/AccessKey.java`: factores 2..7 de derecha a izquierda; `dv = 11 - sum % 11`, 11 → 0, 10 → 1; fecha `ddmmaaaa` desde `issueDate`, `codDoc` `01` y tipo de emisión `1` fijos), `tax-catalog.ts` y `invoice-calculator.ts` (port de `billing/InvoiceCalculator.java` con `Prisma.Decimal`; impuestos ordenados por `Number(rateCode)`; `quantity <= 0`, `unitPrice < 0`, `discount < 0` o `discount > quantity × unitPrice` lanzan `SriError('data', 'INVOICE_LINE_INVALID')`).

- [ ] **Step 5: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing/sri`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/invoicing/sri
git commit -m "feat(invoicing): access key, IVA catalog and invoice totals for the SRI"
```

---

### Task 2: XML de factura 1.1.0

**Files:**
- Create: `api/src/invoicing/sri/invoice-xml.ts`
- Create: `api/test/fixtures/sri/xsd/factura_V1.1.0.xsd`, `api/test/fixtures/sri/xsd/xmldsig-core-schema.xsd` (copiados de `backend-emite-facil/src/main/resources/xsd/invoice/1.1.0/` y `.../xsd/common/`)
- Create: `api/src/invoicing/sri/testing/xsd.ts` (`validateInvoiceXsd(xml: string): Promise<{ valid: boolean; errors: string[] }>` con `xmllint-wasm`, precargando `xmldsig-core-schema.xsd`)
- Create: `api/src/invoicing/sri/testing/sample-document.ts` (`sampleDocument(overrides?: Partial<InvoiceDocument>): InvoiceDocument` con los datos de abajo; lo reutilizan las tareas 4, 6, 8 y 9)
- Test: `api/src/invoicing/sri/invoice-xml.spec.ts`

**Interfaces:**
- Consumes: `InvoiceDocument`, `calculateInvoice`, `ivaRateCode`, `IVA_TAX_CODE` (Task 1).
- Produces: `buildInvoiceXml(doc: InvoiceDocument): string`, `invoiceNumber(doc: Pick<InvoiceDocument, 'establishmentCode' | 'emissionPointCode' | 'sequential'>): string` (`001-002-000000123`), `mainCode(line: DocumentLineInput): string`.

Datos de `sampleDocument()`: ambiente `1`; emisor RUC `1790012345001`, `Clínica Ejemplo S.A.`, nombre comercial `Clínica Ejemplo`, matriz `Av. Amazonas N1-23, Quito`, obligado a contabilidad, sin contribuyente especial ni agente de retención, RIMPE `EMPRENDEDOR`; establecimiento `001`, punto `002`, dirección `Av. Amazonas N1-23, Quito`; secuencial `123`; clave `0710202601179001234500110010020000001231234567816`; fecha `2026-10-07`; cliente `05` / `1710034065` / `Juan Pérez & Hijos` / `juan@example.com` / `Quito` / `0991234567`; las dos líneas de la Task 1; pagos `01` `20.00` y `19` `27.48`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('writes the exact deterministic XML of InvoiceXmlBuilder.java', () => {
  expect(buildInvoiceXml(sampleDocument())).toBe(EXPECTED);
});
it('validates against factura_V1.1.0.xsd', async () => {
  expect(await validateInvoiceXsd(buildInvoiceXml(sampleDocument()))).toEqual({ valid: true, errors: [] });
});
it('replaces characters XML 1.0 forbids and trims long text to 300', async () => {
  const xml = buildInvoiceXml(sampleDocument({ customer: { ...sampleDocument().customer, name: 'A\u0001B' + 'x'.repeat(400) } }));
  expect(xml).toContain('<razonSocialComprador>A B' + 'x'.repeat(297) + '</razonSocialComprador>');
  expect((await validateInvoiceXsd(xml)).valid).toBe(true);
});
it('omits optional fields and infoAdicional when empty', () => {
  const xml = buildInvoiceXml(sampleDocument({ issuer: { ...sampleDocument().issuer, tradeName: null, rimpeRegime: 'NONE' }, customer: { idType: '07', idNumber: '9999999999999', name: 'CONSUMIDOR FINAL' } }));
  expect(xml).not.toContain('<nombreComercial>');
  expect(xml).not.toContain('<contribuyenteRimpe>');
  expect(xml).not.toContain('<infoAdicional>');
});
it('derives a stable main code for lines without a treatment or product code', () => {
  expect(mainCode({ ...sampleDocument().lines[0], code: undefined, localId: 'item-1' })).toMatch(/^HCX-[0-9A-F]{8}$/);
});
```

`EXPECTED` (una sola línea, sin espacios entre elementos):

```xml
<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"><infoTributaria><ambiente>1</ambiente><tipoEmision>1</tipoEmision><razonSocial>Clínica Ejemplo S.A.</razonSocial><nombreComercial>Clínica Ejemplo</nombreComercial><ruc>1790012345001</ruc><claveAcceso>0710202601179001234500110010020000001231234567816</claveAcceso><codDoc>01</codDoc><estab>001</estab><ptoEmi>002</ptoEmi><secuencial>000000123</secuencial><dirMatriz>Av. Amazonas N1-23, Quito</dirMatriz><contribuyenteRimpe>CONTRIBUYENTE RÉGIMEN RIMPE</contribuyenteRimpe></infoTributaria><infoFactura><fechaEmision>07/10/2026</fechaEmision><dirEstablecimiento>Av. Amazonas N1-23, Quito</dirEstablecimiento><obligadoContabilidad>SI</obligadoContabilidad><tipoIdentificacionComprador>05</tipoIdentificacionComprador><razonSocialComprador>Juan Pérez &amp; Hijos</razonSocialComprador><identificacionComprador>1710034065</identificacionComprador><direccionComprador>Quito</direccionComprador><totalSinImpuestos>46.50</totalSinImpuestos><totalDescuento>0.50</totalDescuento><totalConImpuestos><totalImpuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje><baseImponible>40.00</baseImponible><valor>0.00</valor></totalImpuesto><totalImpuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><baseImponible>6.50</baseImponible><valor>0.98</valor></totalImpuesto></totalConImpuestos><propina>0.00</propina><importeTotal>47.48</importeTotal><moneda>DOLAR</moneda><pagos><pago><formaPago>01</formaPago><total>20.00</total></pago><pago><formaPago>19</formaPago><total>27.48</total></pago></pagos></infoFactura><detalles><detalle><codigoPrincipal>PSI-01</codigoPrincipal><descripcion>Sesión de psicoterapia</descripcion><cantidad>1.000000</cantidad><precioUnitario>40.000000</precioUnitario><descuento>0.00</descuento><precioTotalSinImpuesto>40.00</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo><codigoPorcentaje>0</codigoPorcentaje><tarifa>0.00</tarifa><baseImponible>40.00</baseImponible><valor>0.00</valor></impuesto></impuestos></detalle><detalle><codigoPrincipal>PRD-7</codigoPrincipal><descripcion>Cuaderno &lt;A5&gt;</descripcion><cantidad>2.000000</cantidad><precioUnitario>3.500000</precioUnitario><descuento>0.50</descuento><precioTotalSinImpuesto>6.50</precioTotalSinImpuesto><impuestos><impuesto><codigo>2</codigo><codigoPorcentaje>4</codigoPorcentaje><tarifa>15.00</tarifa><baseImponible>6.50</baseImponible><valor>0.98</valor></impuesto></impuestos></detalle></detalles><infoAdicional><campoAdicional nombre="Email">juan@example.com</campoAdicional><campoAdicional nombre="Teléfono">0991234567</campoAdicional></infoAdicional></factura>
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing/sri/invoice-xml`
Expected: FAIL con "Cannot find module './invoice-xml'".

- [ ] **Step 3: Implementar** `buildInvoiceXml` como port de `xml/InvoiceXmlBuilder.java` + `xml/XmlWriter.java` (mismo orden de elementos, escape de `& < > " '`, leyendas RIMPE del Anexo 22). Diferencias deliberadas con el Java: caracteres no admitidos se reemplazan por espacio en lugar de lanzar; los textos libres (`razonSocial*`, `nombreComercial`, `dir*`, `descripcion`, `direccionComprador`) se recortan a 300 caracteres y `codigoPrincipal` a 25; no se escribe `RUC Proveedor`; `infoAdicional` lleva `Email` y `Teléfono` del cliente si existen. `mainCode` = `line.code` o `'HCX-' + sha256(localId)` en hexadecimal mayúsculas, 8 caracteres.

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing/sri/invoice-xml`
Expected: PASS (4 de 5 si la XSD falla: corregir el orden de elementos hasta que pase la validación).

- [ ] **Step 5: Commit**

```bash
git add src/invoicing/sri test/fixtures/sri
git commit -m "feat(invoicing): build the SRI invoice XML 1.1.0"
```

---

### Task 3: Certificado `.p12`

**Files:**
- Create: `api/src/invoicing/sri/certificate.ts`
- Create: `api/src/invoicing/sri/testing/test-certificate.ts`
- Test: `api/src/invoicing/sri/certificate.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SigningMaterial { privateKey: forge.pki.rsa.PrivateKey; certificate: forge.pki.Certificate; certificateDer: Buffer; subject: string; issuerName: string /* RFC 2253, como X500Principal.getName() */; serial: string /* decimal */; validFrom: Date; validTo: Date; sha256: string; identifiers: string[] /* 10 y 13 dígitos hallados en sujeto y extensiones */ }
  export function openCertificate(p12: Buffer, password: string, now?: Date): SigningMaterial
  export function certificateMatchesRuc(m: SigningMaterial, ruc: string): 'MATCH' | 'MISMATCH' | 'UNKNOWN'
  export function assertCertificateFor(m: SigningMaterial, ruc: string): void // MISMATCH → SriError('configuration','CERTIFICATE_RUC_MISMATCH')
  ```
- Produces (testing): `createTestP12(opts?: { ruc?: string; password?: string; validFrom?: Date; validTo?: Date; algorithm?: '3des' | 'aes256'; withChain?: boolean; identifierInSubject?: boolean }): Buffer` — por defecto RUC `1790012345001` en el atributo `serialNumber` del sujeto, contraseña `clave-prueba`, vigente un año desde hoy, `3des`. Generar el par RSA 2048 con `crypto.generateKeyPairSync` y convertirlo a forge (más rápido que forge).

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('opens a legacy 3DES p12 and reads its metadata', () => {
  const m = openCertificate(createTestP12(), 'clave-prueba');
  expect(m.serial).toMatch(/^\d+$/);
  expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(certificateMatchesRuc(m, '1790012345001')).toBe('MATCH');
});
it('opens an OpenSSL 3 style AES-256 p12', () => expect(() => openCertificate(createTestP12({ algorithm: 'aes256' }), 'clave-prueba')).not.toThrow());
it('picks the certificate that belongs to the private key when the p12 carries a chain', () => {
  const m = openCertificate(createTestP12({ withChain: true }), 'clave-prueba');
  expect(m.certificate.publicKey).toMatchObject({ n: m.privateKey.n });
});
it.each([
  [{ password: 'otra' }, 'CERTIFICATE_PASSWORD_INVALID'],
  [{ validTo: new Date(Date.now() - 86400000), validFrom: new Date(Date.now() - 2 * 86400000) }, 'CERTIFICATE_EXPIRED'],
  [{ validFrom: new Date(Date.now() + 86400000) }, 'CERTIFICATE_NOT_YET_VALID'],
])('rejects %o', (opts, code) => {
  const p12 = createTestP12({ ...opts, password: 'clave-prueba' });
  expect(() => openCertificate(p12, (opts as any).password ?? 'clave-prueba')).toThrow(expect.objectContaining({ kind: 'configuration', code }));
});
it('rejects bytes that are not a p12', () => expect(() => openCertificate(Buffer.from('nope'), 'x')).toThrow(expect.objectContaining({ code: 'CERTIFICATE_UNREADABLE' })));
it('matches a natural person RUC by its cédula', () => expect(certificateMatchesRuc(openCertificate(createTestP12({ ruc: '1710034065' }), 'clave-prueba'), '1710034065001')).toBe('MATCH'));
it('reports a different RUC as mismatch and no identifier as unknown', () => {
  expect(certificateMatchesRuc(openCertificate(createTestP12({ ruc: '0990012345001' }), 'clave-prueba'), '1790012345001')).toBe('MISMATCH');
  expect(certificateMatchesRuc(openCertificate(createTestP12({ identifierInSubject: false }), 'clave-prueba'), '1790012345001')).toBe('UNKNOWN');
});
```

Nota para la prueba de contraseña: el p12 se crea con `clave-prueba` y se abre con `otra`.

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing/sri/certificate`
Expected: FAIL con "Cannot find module './certificate'".

- [ ] **Step 3: Implementar** con `forge.asn1.fromDer` + `forge.pkcs12.pkcs12FromAsn1(asn1, false, password)`. Un error de MAC o de descifrado pasa a `CERTIFICATE_PASSWORD_INVALID`; un error de ASN.1 a `CERTIFICATE_UNREADABLE`; si no hay clave RSA, `CERTIFICATE_NO_RSA_KEY`. Elegir el certificado cuyo módulo coincide con el de la clave. `identifiers`: todas las secuencias `\d{10}` y `\d{13}` en los valores de atributos del sujeto y en el valor de las extensiones con OID bajo `1.3.6.1.4.1.37746` (Security Data), `1.3.6.1.4.1.37947` (BCE) y `1.3.6.1.4.1.18332` (ANF). `MATCH` si alguna es igual al RUC o a sus 10 primeros dígitos; `UNKNOWN` si no hay ninguna.

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing/sri/certificate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/invoicing/sri
git commit -m "feat(invoicing): open and validate the issuer's p12 certificate"
```

---

### Task 4: Firma XAdES-BES

**Files:**
- Create: `api/src/invoicing/sri/c14n.ts`, `xades-signer.ts`, `xades-verifier.ts`
- Test: `api/src/invoicing/sri/xades.spec.ts`

**Interfaces:**
- Consumes: `SigningMaterial` (Task 3), `buildInvoiceXml`, `sampleDocument`, `validateInvoiceXsd` (Task 2).
- Produces: `canonicalize(element: Element): string` (C14N inclusiva de `xml-crypto` con los namespaces heredados de los ancestros); `signInvoiceXml(xml: string, material: SigningMaterial, signingTime: Date): string`; `verifyInvoiceSignature(signedXml: string): { valid: boolean; reason: string | null; certificateSha256: string | null }`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
const material = openCertificate(createTestP12(), 'clave-prueba');
const signed = () => signInvoiceXml(buildInvoiceXml(sampleDocument()), material, new Date('2026-10-07T15:15:30.456Z'));
it('produces a signature our verifier and xml-crypto both accept', () => {
  expect(verifyInvoiceSignature(signed())).toEqual({ valid: true, reason: null, certificateSha256: material.sha256 });
  // verificación independiente: SignedXml de xml-crypto con publicCert = PEM del certificado y getCertFromKeyInfo deshabilitado
  expect(checkWithXmlCrypto(signed(), material)).toBe(true);
});
it('follows Anexo 14', () => {
  const xml = signed();
  expect(xml.endsWith('</ds:Signature></factura>')).toBe(true);
  expect(xml).toContain('<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></ds:CanonicalizationMethod>');
  expect(xml).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"');
  expect(xml).toContain('Type="http://uri.etsi.org/01903#SignedProperties"');
  expect(xml).toContain('<etsi:SigningTime>2026-10-07T10:15:30-05:00</etsi:SigningTime>');
  expect(xml).toContain('<etsi:Description>contenido comprobante</etsi:Description><etsi:MimeType>text/xml</etsi:MimeType>');
  expect(xml.match(/<ds:Reference /g)).toHaveLength(3);
  expect(xml).toMatch(/<ds:SignatureValue[^>]*>[A-Za-z0-9+/=]+<\/ds:SignatureValue>/);
});
it.each([
  ['comprobante', (x: string) => x.replace('<importeTotal>47.48<', '<importeTotal>47.49<')],
  ['signed properties', (x: string) => x.replace('2026-10-07T10:15:30-05:00', '2026-10-07T10:15:31-05:00')],
  ['key info', (x: string) => x.replace(/<ds:Exponent>[^<]+</, '<ds:Exponent>AQAA<')],
])('detects tampering of the %s', (_, tamper) => expect(verifyInvoiceSignature(tamper(signed())).valid).toBe(false));
it('keeps the signed invoice valid against the XSD', async () => expect((await validateInvoiceXsd(signed())).valid).toBe(true));
it('refuses to sign twice or a root without id="comprobante"', () => {
  expect(() => signInvoiceXml(signed(), material, new Date())).toThrow();
  expect(() => signInvoiceXml('<factura version="1.1.0"></factura>', material, new Date())).toThrow();
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing/sri/xades`
Expected: FAIL con "Cannot find module './xades-signer'".

- [ ] **Step 3: Implementar** como port de `signature/XadesBesSigner.java` y `XadesVerifier.java`:
  1. Parsear con `@xmldom/xmldom`. Construir `ds:Signature` (con `xmlns:ds`) que contiene `ds:SignedInfo`, `ds:SignatureValue`, `ds:KeyInfo` (`X509Data` + `KeyValue/RSAKeyValue`, módulo y exponente sin byte de signo) y `ds:Object` con `etsi:QualifyingProperties` (con `xmlns:etsi="http://uri.etsi.org/01903/v1.3.2#"`). Ids con números aleatorios de 6 dígitos como en el Java. `X509IssuerName` en RFC 2253 (orden inverso, `CN=...,O=...,C=EC`) y `X509SerialNumber` en decimal.
  2. Insertarla como último hijo de la raíz antes de calcular digests, para que `canonicalize` vea los namespaces reales.
  3. Digests SHA-1 en base64: comprobante = `canonicalize(root)` sin el nodo `ds:Signature` (transform enveloped); `SignedProperties` y `KeyInfo` = `canonicalize(elemento)`.
  4. `SignatureValue` = RSA-SHA1 (forge `md.sha1` + `privateKey.sign`) de `canonicalize(SignedInfo)`, en base64 de una línea.
  5. Serializar con `XMLSerializer`, conservando la declaración `<?xml version="1.0" encoding="UTF-8"?>`.
  El verificador recalcula los tres digests y la firma con la clave del `X509Certificate` embebido, y compara `CertDigest` con el SHA-1 del DER.

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing/sri/xades`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/invoicing/sri
git commit -m "feat(invoicing): sign invoices with XAdES-BES"
```

---

### Task 5: Cliente SOAP del SRI y XML autorizado

**Files:**
- Create: `api/src/invoicing/sri/sri-client.ts`, `authorized-xml.ts`
- Create: `api/src/invoicing/sri/testing/sri-soap-samples.ts` (port de `backend-emite-facil/src/test/java/.../support/SriSoapSamples.java`: `received()`, `returned(key, ...msgs)`, `authorized(key, environment?)`, `notAuthorized(key, state, ...msgs)`, `authorizations(key, ...items)`)
- Test: `api/src/invoicing/sri/sri-client.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ReceptionResult { outcome: 'RECEIVED' | 'RETURNED'; sriStatus: string; messages: SriMessage[] }
  export interface AuthorizationResult { outcome: 'AUTHORIZED' | 'NOT_AUTHORIZED' | 'PENDING'; sriStatus: string | null; authorizationNumber: string | null; authorizedAt: Date | null; environmentLabel: string | null; messages: SriMessage[] }
  export const SRI_ENDPOINTS: Record<SriEnvironment, { reception: string; authorization: string }>
  export class SriClient {
    constructor(options?: { fetch?: typeof fetch; testBaseUrl?: string; timeoutMs?: number /* 15000 */ })
    send(environment: SriEnvironment, signedXml: Buffer): Promise<ReceptionResult>
    authorize(environment: SriEnvironment, accessKey: string): Promise<AuthorizationResult>
    ping(environment: SriEnvironment): Promise<boolean> // GET <reception>?wsdl
  }
  export function hasMessage(r: { messages: SriMessage[] }, identifier: string): boolean
  export function buildAuthorizedXml(input: { signedXml: string; authorizationNumber: string; authorizedAt: Date; environmentLabel: 'PRUEBAS' | 'PRODUCCIÓN' }): string
  ```
  Errores: red, timeout (`AbortController`), HTTP ≥ 500, 429 (con `retryAfterMs` de `Retry-After`), SOAP fault o respuesta ilegible → `SriError('transient', 'SRI_UNAVAILABLE' | 'SRI_TIMEOUT' | 'SRI_INVALID_RESPONSE')`. `testBaseUrl` solo se acepta si `process.env.NODE_ENV === 'test'`; si no, el constructor lanza.

- [ ] **Step 1: Escribir las pruebas que fallan** (con un `fetch` falso que captura la petición)

```ts
const KEY = '0503201201176001321000110010030009900641234567814';
it('posts validarComprobante with the signed XML in base64 to celcer', async () => {
  const { client, calls } = fake(received());
  await expect(client.send('1', Buffer.from('<x/>'))).resolves.toEqual({ outcome: 'RECEIVED', sriStatus: 'RECIBIDA', messages: [] });
  expect(calls[0].url).toBe('https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline');
  expect(calls[0].body).toContain('<ec:validarComprobante><xml>PHgvPg==</xml></ec:validarComprobante>');
  expect(calls[0].headers['Content-Type']).toBe('text/xml; charset=utf-8');
  expect(calls[0].redirect).toBe('error');
});
it('reads every message of a DEVUELTA', async () => {
  const r = await fake(returned(KEY, { identifier: '43', message: 'CLAVE ACCESO REGISTRADA', additionalInfo: null, type: 'ERROR' })).client.send('2', Buffer.from('x'));
  expect(r.outcome).toBe('RETURNED');
  expect(hasMessage(r, '43')).toBe(true);
});
it('reads an authorization with a trimmed number, date and environment', async () => {
  expect(await fake(authorized(KEY)).client.authorize('1', KEY)).toEqual({
    outcome: 'AUTHORIZED', sriStatus: 'AUTORIZADO', authorizationNumber: KEY,
    authorizedAt: new Date('2012-03-05T16:57:34.997-05:00'), environmentLabel: 'PRUEBAS',
    messages: [{ identifier: '60', message: 'ESTE PROCESO FUE REALIZADO EN EL AMBIENTE DE PRUEBAS', additionalInfo: null, type: 'ADVERTENCIA' }],
  });
});
it.each(['NO AUTORIZADO', 'RECHAZADO'])('maps %s to NOT_AUTHORIZED', async (state) =>
  expect((await fake(notAuthorized(KEY, state, { identifier: '46', message: 'RUC no existe', additionalInfo: null, type: 'ERROR' })).client.authorize('1', KEY)).outcome).toBe('NOT_AUTHORIZED'));
it('treats zero authorizations and EN PROCESO as PENDING', async () => {
  expect((await fake(authorizations(KEY)).client.authorize('1', KEY)).outcome).toBe('PENDING');
});
it('prefers an AUTORIZADO entry when the SRI lists several', async () => { /* authorizations(KEY, notAuthorizedItem, authorizedItem) → AUTHORIZED */ });
it.each([
  ['HTTP 503', { status: 503 }, 'SRI_UNAVAILABLE'],
  ['SOAP fault', { body: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>x</faultstring></soap:Fault></soap:Body></soap:Envelope>' }, 'SRI_INVALID_RESPONSE'],
  ['timeout', { hang: true }, 'SRI_TIMEOUT'],
  ['DOCTYPE', { body: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>' }, 'SRI_INVALID_RESPONSE'],
])('classifies %s as transient', async (_, response, code) =>
  await expect(fake(response).client.send('1', Buffer.from('x'))).rejects.toMatchObject({ kind: 'transient', code }));
it('honours Retry-After on 429', async () => await expect(fake({ status: 429, headers: { 'Retry-After': '120' } }).client.send('1', Buffer.from('x'))).rejects.toMatchObject({ retryAfterMs: 120000 }));
it('refuses a test base URL outside NODE_ENV=test', () => { /* con NODE_ENV='production' el constructor lanza */ });
it('wraps the signed XML in an autorizacion document', () => {
  expect(buildAuthorizedXml({ signedXml: '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"></factura>', authorizationNumber: KEY, authorizedAt: new Date('2026-10-07T15:15:30Z'), environmentLabel: 'PRUEBAS' }))
    .toBe(`<?xml version="1.0" encoding="UTF-8"?><autorizacion><estado>AUTORIZADO</estado><numeroAutorizacion>${KEY}</numeroAutorizacion><fechaAutorizacion>2026-10-07T10:15:30-05:00</fechaAutorizacion><ambiente>PRUEBAS</ambiente><comprobante><![CDATA[<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"></factura>]]></comprobante></autorizacion>`);
});
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing/sri/sri-client`
Expected: FAIL con "Cannot find module './sri-client'".

- [ ] **Step 3: Implementar** como port de `sri/SriSoapRequests.java`, `HttpSriGateway.java` y `SriResponseParser.java` (sobres SOAP 1.1 exactos de `SriSoapRequests`, `SOAPAction: ""`, `redirect: 'error'`). Antes de parsear, rechazar cualquier respuesta que contenga `<!DOCTYPE` o `<!ENTITY`. Buscar elementos por nombre local, ignorando prefijos. `buildAuthorizedXml` es port de `delivery/AuthorizedXmlBuilder.java`; si el XML firmado contiene `]]>`, partir el CDATA como hace el Java.

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing/sri/sri-client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/invoicing/sri
git commit -m "feat(invoicing): SRI offline reception and authorization client"
```

---

### Task 6: RIDE en PDF

**Files:**
- Create: `api/src/invoicing/sri/ride.ts`
- Test: `api/src/invoicing/sri/ride.spec.ts`

**Interfaces:**
- Consumes: `InvoiceDocument`, `calculateInvoice`, `invoiceNumber`, `sampleDocument`; `src/common/pdf/standard-fonts.ts` (ya existente: usarlo igual que los otros PDFs del proyecto).
- Produces: `renderRide(input: { document: InvoiceDocument; authorizationNumber: string; authorizedAt: Date }): Promise<Buffer>`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('renders a PDF with the access key, number and totals', async () => {
  const pdf = await renderRide({ document: sampleDocument(), authorizationNumber: sampleDocument().accessKey, authorizedAt: new Date('2026-10-07T15:20:00Z') });
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  const text = await pdfText(pdf); // helper con pdfkit sin compresión: `compress: false` vía opción de prueba, o pdf-parse si ya está en devDependencies
  expect(text).toContain('001-002-000000123');
  expect(text).toContain('0710202601179001234500110010020000001231234567816');
  expect(text).toContain('47.48');
  expect(text).toContain('CONTRIBUYENTE RÉGIMEN RIMPE');
  expect(text).toContain('PRUEBAS');
});
it('renders many lines across pages', async () => { /* 80 líneas → el PDF tiene más de una página (/Type /Page aparece ≥ 2 veces) */ });
```

Para leer texto, `renderRide` acepta un segundo parámetro interno `{ compress?: boolean }` (por defecto `true`); la prueba usa `false` y busca las cadenas en el PDF sin comprimir.

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing/sri/ride`
Expected: FAIL con "Cannot find module './ride'".

- [ ] **Step 3: Implementar** como port de `backend-emite-facil/src/main/java/com/example/einvoice/delivery/RideLayout.java` y `RidePdfBuilder.java` (A4, mismas secciones y textos, sin logo). Código de barras: `bwip-js` `toBuffer({ bcid: 'code128', text: accessKey, scale: 2, height: 12 })` insertado como PNG. Ambiente `1` → `PRUEBAS`, `2` → `PRODUCCIÓN`. Fecha de autorización en hora de Ecuador.

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing/sri/ride`
Expected: PASS.

- [ ] **Step 5: Comprobar el empaquetado de Vercel.** `npm run build` y trazar `dist/src/main.js` con `@vercel/nft` en un directorio de scratch: `bwip-js` y `node-forge` deben aparecer completos y sin `require` dinámicos sin resolver.

- [ ] **Step 6: Commit**

```bash
git add src/invoicing/sri
git commit -m "feat(invoicing): render the RIDE PDF"
```

---

### Task 7: Emisor, certificado y puntos de emisión (migración aditiva)

**Files:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/20261102000000_own_sri_issuer/migration.sql`
- Create: `api/src/invoicing/issuer.service.ts`, `api/src/invoicing/dto/issuer.dto.ts`
- Modify: `api/src/invoicing/invoicing.controller.ts`, `invoicing.module.ts`, `invoice-errors.ts`, `api/src/prisma/prisma.service.ts` (listas `delegateNames` y `orderedModels`)
- Test: `api/src/invoicing/issuer.service.spec.ts`

**Interfaces:**
- Consumes: `openCertificate`, `certificateMatchesRuc` (Task 3), `SriClient.ping` (Task 5).
- Produces (schema, todo lo nuevo; lo viejo sigue hasta la Task 12):
  - `enum RimpeRegime { NONE EMPRENDEDOR NEGOCIO_POPULAR }`.
  - `model InvoicingIssuer` con los campos de la spec (sección «Modelo de datos»), relación 1:1 con `Tenant` (`onDelete: Restrict`) y `points BranchEmissionPoint[]`, `sequences InvoiceSequence[]`, `requests InvoiceRequest[]`, `events InvoiceRequestEvent[]`.
  - `model InvoiceSequence { id; issuerId; establishmentCode; emissionPointCode; environment; next Int @default(1); @@unique([issuerId, establishmentCode, emissionPointCode, environment]) }`.
  - `BranchEmissionPoint`: `connectionId`, `establishmentId` y `emissionPointId` pasan a opcionales; nuevos `issuerId String?` (FK) y `establishmentAddress String?`; `@@unique([issuerId, establishmentCode, emissionPointCode])`.
  - `InvoiceRequest`: `connectionId` y `providerIdempotencyKey` opcionales; nuevos `issuerId String?` (FK), `sequential String?`, `signedXmlStorageKey String?`, `signedXmlSha256 String?`, `emailedAt DateTime?`, `emailAttempts Int @default(0)`; `@@unique([issuerId, accessKey])`.
  - `InvoiceRequestEvent`: `connectionId` opcional, nuevo `issuerId String?` (FK).
- Produces (servicio):
  ```ts
  class IssuerService {
    get(tenantId: string): Promise<IssuerView | null>
    save(tenantId: string, userId: string, dto: SaveIssuerDto): Promise<IssuerView>
    saveCertificate(tenantId: string, userId: string, file: Buffer, password: string): Promise<IssuerView>
    test(tenantId: string): Promise<{ certificateValid: boolean; certificateError: string | null; rucVerified: boolean; sriReachable: boolean }>
    setPoint(tenantId: string, userId: string, branchId: string, dto: EmissionPointDto): Promise<IssuerView['points'][number]>
    loadSigningMaterial(issuer: InvoicingIssuer): SigningMaterial // descifra y abre; lo usa el emisor
  }
  type IssuerView = { id; ruc; legalName; tradeName; headOfficeAddress; accountingRequired; specialTaxpayerCode; withholdingAgentCode; rimpeRegime; environment: '1' | '2'; active; revision;
    certificate: { subject: string; serial: string; validTo: string; sha256: string; rucVerified: boolean } | null;
    points: { branchId: string; establishmentCode: string; emissionPointCode: string; establishmentAddress: string; nextSequential: number }[] }
  ```
- Produces (DTO): `SaveIssuerDto { ruc /^\d{13}$/ terminando en 001; legalName (1..300); tradeName? (≤300); headOfficeAddress (1..300); accountingRequired: boolean; specialTaxpayerCode? (/^\d{3,13}$/); withholdingAgentCode? (/^\d{1,8}$/); rimpeRegime; environment: '1'|'2'; active?: boolean; revision?: number }`; `EmissionPointDto` reemplazado por `{ establishmentCode /^\d{3}$/ distinto de 000; emissionPointCode igual; establishmentAddress (1..300); nextSequential? (1..999999999) }`.
- Rutas nuevas (`InvoicingController`, rol MASTER): `GET invoicing/issuer`, `PUT invoicing/issuer`, `PUT invoicing/issuer/certificate` (`FileInterceptor('file', { limits: { fileSize: 50 * 1024 } })` + body `password`), `POST invoicing/issuer/test` (temporal: pasa a `invoicing/test` en la Task 12, cuando se elimina el de la conexión), `PUT branches/:branchId/emission-point` (pasa a usar `IssuerService.setPoint`).
- Errores nuevos en `invoice-errors.ts`: `INVOICING_NOT_CONFIGURED`, `INVOICING_CERTIFICATE_REQUIRED`, `CERTIFICATE_PASSWORD_INVALID`, `CERTIFICATE_UNREADABLE`, `CERTIFICATE_EXPIRED`, `CERTIFICATE_NOT_YET_VALID`, `CERTIFICATE_NO_RSA_KEY`, `CERTIFICATE_RUC_MISMATCH`, `INVOICING_SERIES_TAKEN`, `INVOICING_SEQUENCE_BACKWARDS`, `TAX_RATE_UNSUPPORTED`, `INVOICE_LINE_INVALID`, `FINAL_CONSUMER_LIMIT`, `SRI_UNAVAILABLE`, `SRI_TIMEOUT`, `SRI_INVALID_RESPONSE`, `SRI_REJECTED`, `INVOICE_SIGNED_XML_INTEGRITY`, con mensajes en español en el tono de los existentes.

- [ ] **Step 1: Escribir las pruebas que fallan** (Prisma simulado como en `connection.service.spec.ts`)

```ts
it('saves issuer data with an audit entry and bumps the revision', ...);
it('locks the RUC once the issuer has an invoice request', async () => { /* count > 0 y RUC distinto → INVOICING_IDENTITY_LOCKED */ });
it('refuses an environment change while requests are REQUESTED, PROCESSING or AUTHORIZED without artifacts', ...); // INVOICING_ENVIRONMENT_BUSY
it('stores the certificate and password encrypted and returns only metadata', async () => {
  const view = await service.saveCertificate(t, u, createTestP12(), 'clave-prueba');
  expect(view.certificate).toMatchObject({ rucVerified: true });
  const data = prisma.invoicingIssuer.update.mock.calls[0][0].data;
  expect(data.certificateEncrypted).not.toContain('MII'); // nunca en claro
  expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain('clave-prueba');
});
it('rejects a certificate of another RUC', ...); // 422 CERTIFICATE_RUC_MISMATCH
it('rejects certificates without encryption configured', ...); // 503 INVOICING_ENCRYPTION_REQUIRED
it('creates the point and its sequence; the next sequential only moves up', async () => {
  // nextSequential 500 → upsert de InvoiceSequence con next 500; luego 400 → 409 INVOICING_SEQUENCE_BACKWARDS
});
it('refuses a series already assigned to another branch', ...); // 409 INVOICING_SERIES_TAKEN
it('reports certificate and SRI reachability in test()', ...);
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing/issuer`
Expected: FAIL con "Cannot find module './issuer.service'".

- [ ] **Step 3: Schema y migración.** Editar `schema.prisma` y generar el SQL con `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script --shadow-database-url <postgres desechable>` (ver la memoria «editing-and-verification-environment»: `embedded-postgres` en un directorio de scratch, nunca el `DATABASE_URL` de `.env`). Guardarlo como `20261102000000_own_sri_issuer/migration.sql`, revisar que solo añade cosas y relaja `NOT NULL`, y luego `npx prisma generate`.

- [ ] **Step 4: Implementar** `IssuerService` (patrón de `connection.service.ts`: `runSerializableTransaction`, CAS por `revision`, auditoría con `ISSUER_SAVED`, `CERTIFICATE_REPLACED` con `sha256` y `EMISSION_POINT_SAVED`). El certificado se guarda como `crypto.encryptBuffer(tenantId, p12).toString('base64')` y la contraseña con `crypto.encrypt`. Un `SriError` de certificado pasa a 422. Registrar `SriClient` en el módulo con un factory: `new SriClient({ testBaseUrl: process.env.NODE_ENV === 'test' ? config.get('SRI_TEST_BASE_URL') : undefined })`. Agregar `invoicingIssuer` e `invoiceSequence` a las dos listas de `prisma.service.ts` junto a las de facturación.

- [ ] **Step 5: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing src/prisma && npx tsc --noEmit -p tsconfig.json`
Expected: PASS y sin errores de tipos.

- [ ] **Step 6: Comprobar la migración** contra el PostgreSQL desechable: `DATABASE_URL=<desechable> npx prisma migrate deploy`, y que `npx prisma migrate diff --from-url <desechable> --to-schema-datamodel prisma/schema.prisma --script` esté vacío.

- [ ] **Step 7: Commit**

```bash
git add prisma src/invoicing src/prisma
git commit -m "feat(invoicing): local issuer, certificate and emission points"
```

---

### Task 8: Solicitud con snapshot del emisor, preflight y firma

**Files:**
- Modify: `api/src/invoicing/invoice-snapshot.ts`, `invoice-requests.service.ts`, `invoice-worker.service.ts`, `invoicing.module.ts`, `api/src/orders/eligibility-facts.ts`
- Create: `api/src/invoicing/invoice-emitter.ts`
- Test: `api/src/invoicing/invoice-emitter.spec.ts`, `invoice-requests.service.spec.ts` (ampliar), `invoice-snapshot.spec.ts` (ampliar), `api/src/orders/orders.service.spec.ts` (ajustar el mock de `invoicingConfigured`)

**Interfaces:**
- Consumes: `IssuerService.loadSigningMaterial` (Task 7); `buildAccessKey`, `newNumericCode` (Task 1); `buildInvoiceXml` (Task 2); `assertCertificateFor` (Task 3); `signInvoiceXml`, `verifyInvoiceSignature` (Task 4); `FILE_STORAGE`, `ClinicalCryptoService.encryptBuffer`.
- Produces:
  - `FiscalSnapshot` nuevo: `{ customer: CustomerProfile; issuerId: string; issuer: IssuerSnapshot; environment: SriEnvironment; establishmentCode: string; emissionPointCode: string; establishmentAddress: string; issueDate: string; lines: DocumentLineInput[]; payments: Payment[] }` (sin `taxpayerId` ni `replacesDocumentId`). `CustomerProfile` y `Payment` se importan de `sri/sri-types.ts`.
  - `toInvoiceDocument(s: FiscalSnapshot, sequential: number, accessKey: string): InvoiceDocument` en `invoice-snapshot.ts`.
  - `class InvoiceEmitter { advance(row: InvoiceRequest, deadline: number): Promise<void> }`. En esta tarea cubre el preflight y la firma; las tareas 9 y 10 añaden los pasos siguientes al mismo método.
  - El worker conserva `claim`, `lease`, `failed`, `releaseOrder` y `retryDelay`. `process(row)` pasa a `emitter.advance(row, Date.now() + 100000)` dentro del mismo `try/catch` que llama a `failed`. El claim normal selecciona `"issuerId" IS NOT NULL AND "status" IN ('REQUESTED','PROCESSING')`. `failed` usa `SriError`, y su regla «seguro de fallar» pasa a ser `!row.signedXmlStorageKey && (e.kind !== 'transient' || expired)`; con XML firmado el estado se conserva.
  - Eventos con `issuerId` (y `connectionId: null`).

- [ ] **Step 1: Escribir las pruebas que fallan**

`invoice-requests.service.spec.ts`:

```ts
it('freezes the issuer, establishment address and environment in the snapshot', ...);
it('requires an active issuer with a certificate and a point for the branch', ...); // 422 INVOICING_NOT_CONFIGURED
it('refuses a final consumer invoice above USD 50 before marking the order invoiced', async () => {
  // profile idType '07', order.total '50.01' → 422 FINAL_CONSUMER_LIMIT; order.update no se llama
});
it('accepts a final consumer invoice of exactly USD 50', ...);
```

`invoice-emitter.spec.ts` (Prisma simulado con un `InvoiceRequest` que tiene lease vigente; `FileStorage` en memoria; `createTestP12()` como certificado del emisor):

```ts
it('fails safely before signing when the certificate expired', async () => {
  await expect(emitter.advance(row, deadline)).rejects.toMatchObject({ kind: 'configuration', code: 'CERTIFICATE_EXPIRED' });
  expect(storage.keys()).toHaveLength(0);
});
it('reserves the sequence, signs, verifies and stores the signed XML in one leased transaction', async () => {
  await emitter.advance(row, deadline);
  const data = lastUpdate().data;
  expect(data).toMatchObject({ sequential: '000000500', externalState: 'SIGNED', status: 'PROCESSING' });
  expect(data.accessKey.slice(0, 8)).toBe('07102026'); // = fechaEmision del snapshot
  expect(data.accessKey.slice(24, 39)).toBe('001002000000500');
  expect(verifyInvoiceSignature(decrypt(storage.get(data.signedXmlStorageKey))).valid).toBe(true);
  expect(data.signedXmlSha256).toBe(sha256(decrypt(storage.get(data.signedXmlStorageKey))));
});
it('removes the stored file and keeps the sequence when the lease is lost before commit', ...);
it('never re-signs a row that already has signed XML', async () => { /* row con signedXmlStorageKey → no llama a InvoiceSequence */ });
it('signs from the snapshot even if the issuer was edited afterwards', ...);
```

Worker (en el mismo archivo de pruebas): `failed()` con un `SriError('configuration')` sobre una fila firmada deja `status: 'PROCESSING'` y no libera la orden; sobre una fila sin firmar la pasa a `FAILED` y libera la orden.

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing src/orders/orders.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar.**
  - `invoice-requests.service.ts`: usa `invoicingIssuer` (activo, con certificado) y `branchEmissionPoint` con `issuerId`; arma el snapshot nuevo; añade `FINAL_CONSUMER_LIMIT` (`idType === '07' && total > 50`) antes de tocar la orden; crea con `issuerId`. Ya no crea `providerIdempotencyKey`.
  - `eligibility-facts.ts`: `invoicingConfigured` busca el punto de la sucursal con `issuer: { tenantId, active: true, certificateEncrypted: { not: null } }`.
  - Paso de firma, en una `$transaction` con CAS sobre el lease:
    1. `UPDATE "InvoiceSequence" SET "next" = "next" + 1 WHERE ... RETURNING "next" - 1 AS "sequential"`. Si no existe la fila, crearla con `next` 2 y usar 1.
    2. Construir el XML, firmarlo con `signingTime = new Date()` y verificarlo.
    3. `storage.put('invoices/<tenant>/<id>/signed-<uuid>', encryptBuffer(...))`.
    4. `updateMany` con `leaseToken`, `signedXmlStorageKey: null`. Si `count === 0`, lanzar para revertir la reserva y borrar el archivo en el `catch`.
    5. Crear el evento `SIGNED`.

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing src/orders && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/invoicing src/orders
git commit -m "feat(invoicing): snapshot the local issuer and sign invoices in the worker"
```

---

### Task 9: Recepción y autorización

**Files:**
- Modify: `api/src/invoicing/invoice-emitter.ts`, `invoice-state.ts`, `invoice-worker.service.ts` (claim de reconciliación)
- Test: `api/src/invoicing/invoice-emitter.spec.ts` (ampliar)

**Interfaces:**
- Consumes: `SriClient` (Task 5), `hasMessage`.
- Produces: `advance` continúa desde `SIGNED`/`RECEIVED`. `nextInvoiceStatus(current: InvoiceRequestStatus, stage: 'SIGNED' | 'RECEIVED' | 'AUTHORIZED' | 'RETURNED' | 'NOT_AUTHORIZED'): InvoiceRequestStatus`. El método privado `applyStage(row, stage, data, messages?)` reemplaza a `applyDocument`: hace el `FOR UPDATE`, comprueba el lease y aplica las transiciones terminales igual que hoy (sesiones `BILLED` al autorizar; `releaseOrder` al rechazar).

- [ ] **Step 1: Escribir las pruebas que fallan** (`SriClient` simulado)

```ts
it('asks for the authorization before resending a row that was already sent', async () => {
  // row SIGNED con attempts > 0 → authorize() primero; si es PENDING sin autorizaciones, entonces send()
});
it('sends the exact stored bytes and refuses them if their SHA-256 changed', async () => { /* hash distinto → SriError('configuration','INVOICE_SIGNED_XML_INTEGRITY'), estado intacto, evento */ });
it.each(['43', '70'])('treats DEVUELTA with message %s as received', ...);
it('rejects on any other DEVUELTA, stores the SRI messages encrypted and releases the order', async () => {
  // lastErrorEncrypted descifrado = { code: 'SRI_REJECTED', messages: [...] }; order PAID; sesiones BILLING_FAILED
});
it('authorizes with number and date and bills the sessions', ...);
it('rejects on NO AUTORIZADO', ...);
it('polls twice inline then leaves PENDING for the tick', async () => { /* authorize llamado 3 veces con espera de 3 s (fake timers); status PROCESSING; nextAttemptAt futuro */ });
it('stops at the deadline without starting a new SRI call', ...);
it('keeps a signed row PROCESSING on a transient SRI error after 24 hours', ...);
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing/invoice-emitter`
Expected: FAIL.

- [ ] **Step 3: Implementar** los pasos c y d según la tabla «Pasos» de la spec. El claim de reconciliación del worker selecciona `"issuerId" IS NOT NULL AND ("status" = 'PROCESSING' OR ("status" = 'AUTHORIZED' AND ("xmlStorageKey" IS NULL OR "rideStorageKey" IS NULL OR ("emailedAt" IS NULL AND "emailAttempts" < 5))))`. `lastErrorEncrypted` guarda `{ code, messages }`; `invoice-view.ts` lo publica sin cambios de forma.

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/invoicing
git commit -m "feat(invoicing): send invoices to the SRI and follow their authorization"
```

---

### Task 10: Artefactos y correo

**Files:**
- Modify: `api/src/invoicing/invoice-artifacts.service.ts` (`collect` sin proveedor), `invoice-emitter.ts`, `api/src/mail/mail.service.ts`, `mail.templates.ts`, `invoicing.module.ts` (importar `MailModule`)
- Create: `api/src/invoicing/invoice-delivery.service.ts`
- Test: `api/src/invoicing/invoice-artifacts.service.spec.ts`, `invoice-delivery.service.spec.ts`, `api/src/mail/mail.service.spec.ts` (ampliar)

**Interfaces:**
- Consumes: `buildAuthorizedXml` (Task 5), `renderRide` (Task 6), `toInvoiceDocument` (Task 8).
- Produces:
  - `InvoiceArtifactsService.collect(row: InvoiceRequest): Promise<void>`. Lee el XML firmado guardado y descifra el snapshot. Si falta, guarda `xml` (= `buildAuthorizedXml`) y `ride` (= `renderRide`), cada uno con su propia transacción CAS y su evento `ARTIFACT_STORED`, como hoy. Un fallo se traga y lo reintenta el tick. `read()` no cambia.
  - `MailContent` acepta `attachments?: { filename: string; content: Buffer; contentType: string }[]`. SMTP los pasa a nodemailer; la API HTTP los manda como `attachments: [{ filename, content: base64 }]` (forma de Resend).
  - `invoiceMail(input: { number: string; issuerName: string; customerName: string; authorizedAt: Date }): MailContent`. Asunto exacto: `` `Factura ${number} de ${issuerName}` ``.
  - `InvoiceDeliveryService.deliver(row: InvoiceRequest): Promise<void>`. Sale sin hacer nada si ya hay `emailedAt`, si `emailAttempts >= 5` o si faltan artefactos. Si el cliente no tiene email, fija `emailAttempts = 5` con evento `EMAIL_SKIPPED`, para que el claim de reconciliación de la Task 9 no la vuelva a tomar. Si `send` devuelve `true`, fija `emailedAt` (evento `EMAILED`). Si no, `emailAttempts + 1` (evento `EMAIL_FAILED`) y `nextAttemptAt` según `retryDelay`.

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('stores the authorized XML and the RIDE encrypted with their hashes', ...);
it('keeps the authorization when the RIDE fails to render and retries later', ...);
it('emails both files once to the customer', async () => { /* send con 2 adjuntos: factura-001-002-000000123.xml y .pdf */ });
it('skips customers without email (consumidor final) and marks them so the reconciler stops claiming them', ...);
it('counts failed sends and stops after 5 attempts', ...);
it('passes attachments through SMTP and the HTTP API', ...); // mail.service.spec
it('never puts clinical data in the invoice mail', () => expect(invoiceMail(input).text).not.toMatch(/diagn|sesión|paciente/i));
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing src/mail`
Expected: FAIL.

- [ ] **Step 3: Implementar.** En `advance`: al quedar `AUTHORIZED` (o al reclamarse una fila `AUTHORIZED`) llamar a `artifacts.collect(row)` y luego a `delivery.deliver(row)` mientras quede presupuesto.

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing src/mail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/invoicing src/mail
git commit -m "feat(invoicing): keep the authorized XML and RIDE and email them to the customer"
```

---

### Task 11: Intento inline, tick y programador interno

**Files:**
- Create: `api/src/invoicing/invoicing-tick.controller.ts`
- Modify: `api/src/invoicing/invoice-worker.service.ts`, `invoicing.controller.ts` (`create`), `invoice-requests.service.ts` (exponer `view(tenantId, id)`), `invoicing.module.ts`
- Test: `api/src/invoicing/invoicing-tick.controller.spec.ts`, `invoice-worker.service.spec.ts`

**Interfaces:**
- Produces:
  - `InvoiceWorkerService.processOne(id: string, budgetMs: number): Promise<void>`: reclama esa fila (mismo SQL de claim con `"id" = ${id}`) y la procesa; si no la obtiene, vuelve sin error.
  - `InvoiceWorkerService.tick(budgetMs: number): Promise<{ processed: number }>`: claims sucesivos (normal y de reconciliación) hasta agotar el presupuesto o quedarse sin filas.
  - `@Cron('*/10 * * * * *')` solo actúa si `INVOICING_INTERNAL_SCHEDULER === 'true'` y `NODE_ENV !== 'test'`.
  - `POST internal/invoicing/tick`: `@Public()`, `@HttpCode(200)`, `@Throttle({ default: { limit: 6, ttl: 60000 } })`. Sin `INVOICING_TICK_SECRET` → `NotFoundException`. Cabecera ausente, sin `Bearer ` o de distinta longitud → 401 sin llamar a `timingSafeEqual`. Correcto → `worker.tick(45000)`.
  - `create` en el controlador: `const r = await requests.create(...); await worker.processOne(r.id, 15000); return requests.view(t, r.id)` (sigue en 202).

- [ ] **Step 1: Escribir las pruebas que fallan**

```ts
it('answers 404 when no tick secret is configured', ...);
it.each([undefined, '', 'Bearer', 'Bearer x', 'Basic ' + secret])('answers 401 for %p without throwing from timingSafeEqual', ...);
it('runs one tick with the right secret', ...);
it('returns the state reached inline', ...); // controller create → view tras processOne
it('processOne does nothing when another worker holds the lease', ...);
it('the internal scheduler stays idle unless INVOICING_INTERNAL_SCHEDULER=true', ...);
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx jest src/invoicing`
Expected: FAIL.

- [ ] **Step 3: Implementar** (el prefijo `api/v1` lo pone `main.ts`; el controlador se registra como `@Controller('internal/invoicing')`).

- [ ] **Step 4: Ejecutar y ver que pasan**

Run: `npx jest src/invoicing && npx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/invoicing
git commit -m "feat(invoicing): emit inline and from a secret-protected tick"
```

---

### Task 12: Retirar Emite Fácil (migración de borrado)

**Files:**
- Delete: `api/src/invoicing/provider/` (todo), `invoice-resolver.ts` (+ spec), `invoice-webhook.service.ts`, `connection.service.ts` (+ spec), `dto/invoicing.dto.ts` (lo que quede: `ListInvoiceRequestsQuery` se mueve a `dto/issuer.dto.ts` o a un `dto/invoice-requests.dto.ts`)
- Modify: `api/prisma/schema.prisma`, `invoicing.controller.ts` (quitar `InvoicingWebhookController` y las rutas `connection`/`options`; `issuer/test` pasa a `invoicing/test`), `invoicing.module.ts`, `invoice-errors.ts` (quitar los códigos de Emite Fácil), `invoice-view.ts` (quitar `requiresReconciliation` y `externalDocumentId`; añadir `sequential` y `emailedAt`), `invoice-requests.service.ts` (`blockingInvoiceWhere`), `api/src/orders/payments.service.ts:160-175`, `api/src/treatment-sessions/treatment-sessions.service.ts:565-590,710-720`, `api/src/prisma/prisma.service.ts`, `api/prisma/seed.ts:165-167`, `api/.env.example`
- Create: `api/prisma/migrations/20261102000100_drop_emite_facil/migration.sql`
- Test: specs de `payments`, `treatment-sessions` e `invoice-errors` ajustados

**Interfaces:**
- Produces (schema final): sin `InvoicingConnection` ni `InvoicingRef`. `BranchEmissionPoint.issuerId` y `establishmentAddress` obligatorios, sin `connectionId`/`establishmentId`/`emissionPointId`. `InvoiceRequest.issuerId` obligatorio, sin `connectionId`, `externalDocumentId`, `providerIdempotencyKey`, `providerBodyEncrypted`, `providerBodyHash` ni `requiresReconciliation`. `InvoiceRequestEvent.issuerId` obligatorio, sin `connectionId` ni `webhookEventId` (y sin su `@@unique`).

- [ ] **Step 1: Escribir la prueba de migración que falla**: `api/test/own-sri-invoicing-migration.spec.ts`, en el estilo de `test/master-role-migration.spec.ts`. Sobre una base desechable con las migraciones hasta `20261102000000` y filas de prueba (una solicitud vieja `AUTHORIZED` con orden `INVOICED` y sesión `BILLED`, una `PROCESSING` con sesión `BILLING_PENDING`), aplicar `20261102000100` y comprobar:
  - las solicitudes y eventos sin `issuerId` desaparecen;
  - esas órdenes vuelven a `PAID`;
  - sus sesiones `BILLING_PENDING`/`BILLED` pasan a `BILLING_FAILED`;
  - los puntos sin `issuerId` desaparecen;
  - las tablas `InvoicingConnection` e `InvoicingRef` ya no existen.

- [ ] **Step 2: Ejecutar y ver que falla**

Run: `DATABASE_URL=<desechable> npx jest test/own-sri-invoicing-migration.spec.ts --runInBand`
Expected: FAIL (la migración no existe).

- [ ] **Step 3: Migración.** Escribir primero las sentencias de datos (actualizar órdenes y sesiones, borrar eventos, solicitudes y puntos sin `issuerId`) y después el DDL generado por `prisma migrate diff` para el schema final.

- [ ] **Step 4: Borrar el código y ajustar los usos.** `requiresReconciliation` desaparece de las condiciones de `payments.service`, `treatment-sessions.service` y `blockingInvoiceWhere` (queda `status in REQUESTED/PROCESSING/AUTHORIZED`). En `treatment-sessions.service.ts:587` queda `statusAfterClinicalCompletion(invoice?.status)`. `.env.example` pierde `EMITE_FACIL_API_URL` y gana `INVOICING_TICK_SECRET=` e `INVOICING_INTERNAL_SCHEDULER=false`, con comentarios.

- [ ] **Step 5: Verificar**

Run: `npx prisma generate && npx tsc --noEmit -p tsconfig.json && npx jest && DATABASE_URL=<desechable> npx jest test/own-sri-invoicing-migration.spec.ts --runInBand`
Expected: PASS. `grep -rni "emite" src prisma .env.example` no devuelve nada.

- [ ] **Step 6: Commit**

```bash
git add -A src prisma test .env.example
git commit -m "refactor(invoicing): remove the Emite Fácil integration"
```

---

### Task 13: E2E con un SRI simulado

**Files:**
- Modify (reescribir): `api/test/invoicing.e2e-spec.ts`
- Create: `api/test/helpers/sri-simulator.ts`

**Interfaces:**
- Consumes: `sri-soap-samples.ts` (Task 5), `createTestP12` (Task 3), `InvoiceWorkerService.tick` (Task 11).
- Produces: `startSriSimulator(): Promise<{ baseUrl: string; mode: (m: 'authorize' | 'pending' | 'return' | 'not-authorized' | 'reception-timeout' | 'down') => void; received: { accessKey: string; xml: string }[]; close(): Promise<void> }>`. Sirve `/comprobantes-electronicos-ws/RecepcionComprobantesOffline` y `/AutorizacionComprobantesOffline`, decodifica el base64, extrae `claveAcceso` y recuerda lo recibido. `reception-timeout` registra el comprobante y no responde.

- [ ] **Step 1: Escribir el e2e** (`NODE_ENV=test`, `SRI_TEST_BASE_URL=<simulador>`, `INVOICING_TICK_SECRET=e2e-secret`) con estos casos:
  - `requires issuer, certificate and point before invoicing` → 422 `INVOICING_NOT_CONFIGURED`; luego `PUT issuer`, `PUT issuer/certificate` (multipart), `PUT emission-point` con `nextSequential: 500`.
  - `authorizes inline and serves XML and RIDE` → la respuesta del POST ya trae `AUTHORIZED` y `number: '001-002-000000500'`; `GET /xml` contiene `<estado>AUTORIZADO</estado>`; `GET /ride` empieza con `%PDF-`.
  - `leaves PENDING inline and authorizes from the tick` → `mode('pending')`; POST trae `PROCESSING`; `mode('authorize')`; `POST /api/v1/internal/invoicing/tick` con el secreto → `AUTHORIZED`.
  - `recovers a reception timeout through the access key` → `mode('reception-timeout')`; luego `authorize`; el tick autoriza sin un segundo comprobante con otra clave (`received` tiene una sola clave distinta).
  - `rejects, releases the order and reissues with a new sequential` → `mode('return')`; `REJECTED`, la orden vuelve a `PAID`, la reemisión usa un secuencial mayor que el rechazado (nunca el mismo) y queda enlazada con `replacesInvoiceRequestId`.
  - `gives distinct sequentials to concurrent invoices of one point` → dos órdenes en paralelo dan dos secuenciales distintos y consecutivos.
  - `keeps SRI messages behind billing.view` (adaptar el caso existente del asistente).
  - `blocks refunds while an invoice is PROCESSING`.
  - `enforces the monthly limit` (adaptar el caso existente).
  - `refuses a final consumer invoice above USD 50` → 422 `FINAL_CONSUMER_LIMIT`.

- [ ] **Step 2: Ejecutar sobre PostgreSQL desechable** (ver la memoria «editing-and-verification-environment»)

Run: `DATABASE_URL=<desechable> DATABASE_URL_TEST=<desechable> REDIS_URL="" npx jest --config ./test/jest-e2e.json --runInBand test/invoicing.e2e-spec.ts`
Expected: PASS en todos. Si falla, depurar el código, no relajar las aserciones.

- [ ] **Step 3: Ejecutar el e2e completo** para comprobar que no se rompió caja, órdenes ni sesiones: `npx jest --config ./test/jest-e2e.json --runInBand`. Comparar las fallas con una corrida base en `origin/dev` antes de atribuirlas a este cambio.

- [ ] **Step 4: Commit**

```bash
git add test
git commit -m "test(invoicing): end to end against a simulated SRI"
```

---

### Task 14: Documentación de la API y PR

**Files:**
- Modify: `api/docs/DEPLOYMENT.md` (reemplazar la sección de facturación electrónica), `api/docs/API_ENDPOINTS.md`, `../TAREAS_PENDIENTES.md` (fila §37–41 y la línea de estado de la API)

- [ ] **Step 1: `DEPLOYMENT.md`.**
  - Variables: `INVOICING_TICK_SECRET`, `INVOICING_INTERNAL_SCHEDULER`, `CLINICAL_ENCRYPTION_KEYS` como requisito.
  - Programación del tick en Supabase:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('hcx-invoicing-tick', '* * * * *', $$
  select net.http_post(
    url := 'https://psychology-clinic-saas-api.vercel.app/api/v1/internal/invoicing/tick',
    headers := jsonb_build_object('Authorization', 'Bearer <INVOICING_TICK_SECRET>', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000);
$$);
```

  - Cómo revisarlo (`select * from cron.job_run_details order by start_time desc limit 20;`).
  - `maxDuration` de 60 s para la función en Vercel.
  - La regla de no tocar a mano solicitudes firmadas.
  - El procedimiento de prueba real en `celcer` antes de pasar a producción.
- [ ] **Step 2: `API_ENDPOINTS.md`** con las rutas de la sección «API» de la spec.
- [ ] **Step 3: Verificar formato:** `npx prettier --check $(git diff --name-only origin/dev -- '*.ts')`.
- [ ] **Step 4: Commit, push y PR contra `dev`** (con la aprobación del usuario para publicar).

```bash
git add docs ../TAREAS_PENDIENTES.md
git commit -m "docs(invoicing): deploy and operate the own SRI invoicer"
git push -u origin feat/own-sri-invoicing
gh pr create --base dev --title "feat(invoicing): own SRI invoicer replacing Emite Fácil" --body-file <cuerpo con resumen, pruebas ejecutadas y la prueba manual pendiente en celcer>
```

`TAREAS_PENDIENTES.md` está en la raíz, que no es un repositorio git: se edita, pero no entra en el commit. Quitar `../TAREAS_PENDIENTES.md` del `git add`.

---

### Task 15: Web — configuración del emisor

Trabajar en `web/.worktrees/own-sri-invoicing`.

**Files:**
- Modify: `web/src/types/invoicing.ts`, `web/src/lib/api/invoicing-api.ts`, `web/src/hooks/useInvoicing.ts`, `web/src/features/billing/invoicing-settings.tsx` (reescribir)
- Test: `web/src/features/billing/invoicing-settings.test.tsx` (nuevo), `web/src/features/billing/billing-page.test.tsx` (ajustar)

**Interfaces:**
- Consumes: los contratos de la Task 7 (`IssuerView`, resultado de `test`) y de la Task 12 (`invoiceView` sin `requiresReconciliation` ni `externalDocumentId`, con `sequential` y `emailedAt`).
- Produces:
  - `invoicingApi.issuer(tenantId): Promise<InvoicingIssuer | null>`, `saveIssuer(tenantId, input: SaveIssuerInput)`, `uploadCertificate(tenantId, file: File, password: string)` (`FormData`), `test(tenantId): Promise<IssuerTest>`, `savePoint(tenantId, branchId, input: { establishmentCode; emissionPointCode; establishmentAddress; nextSequential?: number })`.
  - Se eliminan `connection`, `options`, `save`, los tipos `InvoicingConnection`, `ProviderTenant`, `Taxpayer`, `Establishment`, `InvoicingOptions`, `ConnectionTest`, `SaveConnectionInput` y `SriAttempt`.

- [ ] **Step 1: Escribir las pruebas que fallan** (Vitest + Testing Library, con el patrón de `billing-page.test.tsx`)

```tsx
it('saves issuer tax data and environment', ...);
it('uploads the p12 with its password and shows holder, serial and expiry, never the password', ...);
it('warns when the certificate expires within 30 days and when it already expired', ...);
it('warns when the certificate RUC could not be verified', ...); // rucVerified false
it('saves a branch emission point with its next sequential and validates three digits', ...);
it('shows the test result for certificate and SRI', ...);
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx vitest run src/features/billing`
Expected: FAIL.

- [ ] **Step 3: Implementar** las cuatro tarjetas de la spec (sección «Web»), con los componentes que ya usa el archivo (`Card`, `Input`, `Label`, `Button`, `Alert`) y `selectClass` para los selects. Textos en español.

- [ ] **Step 4: Ejecutar**

Run: `npx vitest run && npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "feat(web): configure the clinic as its own SRI issuer"
```

---

### Task 16: Web — estado de la factura en Caja y PR

**Files:**
- Modify: `web/src/features/cash/invoice-summary.tsx`, `invoice-request-panel.tsx:48`, `web/src/hooks/useInvoicing.ts:29,77`, `web/src/features/cash/invoicing.test.tsx`, `web/src/features/billing/patient-invoices-tab.tsx` (si muestra campos eliminados)

- [ ] **Step 1: Escribir las pruebas que fallan** en `invoicing.test.tsx`:

```tsx
it('shows the SRI messages of a rejected invoice and offers to reissue', ...);
it('shows a processing invoice as waiting for the SRI and keeps polling', ...); // reemplaza los casos de requiresReconciliation
it('no longer mentions emite-facil', () => expect(screen.queryByText(/emite-facil/i)).toBeNull());
it('shows that the invoice was emailed', ...); // emailedAt
```

- [ ] **Step 2: Ejecutar y ver que fallan**

Run: `npx vitest run src/features/cash`
Expected: FAIL.

- [ ] **Step 3: Implementar.** Una solicitud está «en curso» cuando su estado es `REQUESTED` o `PROCESSING`. Se quitan los textos de `SIGNATURE_FAILED` y de «corrige en emite-facil». `lastError.messages` se lista con `identifier`, `message` y `additionalInfo`.

- [ ] **Step 4: Ejecutar**

Run: `npx vitest run && npm run type-check && npm run lint && npm run build`
Expected: PASS. `grep -rni "emite-facil" src` no devuelve nada.

- [ ] **Step 5: Commit, push y PR contra `dev`** (con la aprobación del usuario para publicar), indicando en el cuerpo que depende del PR de la API.

```bash
git add src
git commit -m "feat(web): show SRI results in the cash invoice panel"
git push -u origin feat/own-sri-invoicing
gh pr create --base dev --title "feat(web): own SRI invoicer settings and invoice status"
```

---

## Verificación final (después de la Task 16)

- API: `npx jest` completo y el e2e de facturación en verde. El usuario hace la emisión manual en `celcer` con su certificado de pruebas (no la puede hacer el agente).
- Web: con la API local de la rama, configurar emisor, certificado y punto, cobrar una orden y facturarla contra el simulador. Revisar la UI en el navegador con `preview_start` (`web` de `.claude/launch.json`).
