import { createHash } from 'crypto';
import * as forge from 'node-forge';
import { SriError } from './sri-types';

export interface SigningMaterial {
  privateKey: forge.pki.rsa.PrivateKey;
  certificate: forge.pki.Certificate;
  certificateDer: Buffer;
  subject: string;
  /** RFC 2253, as Java's X500Principal.getName() (goes into X509IssuerName). */
  issuerName: string;
  /** Decimal. */
  serial: string;
  validFrom: Date;
  validTo: Date;
  sha256: string;
  /** 10 and 13 digit values found in the subject and in the Ecuadorian CA extensions. */
  identifiers: string[];
}

/** Security Data, BCE and ANF AC extension arcs that carry the holder's RUC / cédula. */
const IDENTIFIER_EXTENSION_ARCS = ['1.3.6.1.4.1.37746', '1.3.6.1.4.1.37947', '1.3.6.1.4.1.18332'];

/** Keywords RFC 2253 defines; any other attribute is written as OID=#hex(DER). */
const RFC2253_KEYWORDS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.6': 'C',
  '0.9.2342.19200300.100.1.25': 'DC',
  '0.9.2342.19200300.100.1.1': 'UID',
};

const UTF8_TAG = forge.asn1.Type.UTF8;

function escapeRfc2253(value: string): string {
  let out = value.replace(/[,+"\\<>;]/g, (c) => `\\${c}`);
  if (out.startsWith('#') || out.startsWith(' ')) out = `\\${out}`;
  if (out.endsWith(' ') && !out.endsWith('\\ ')) out = `${out.slice(0, -1)}\\ `;
  return out;
}

function formatAttribute(attr: forge.pki.CertificateField): string {
  const oid = attr.type as string;
  const raw = String(attr.value ?? '');
  const keyword = RFC2253_KEYWORDS[oid];
  if (keyword) {
    const tagNumber = attr.valueTagClass as unknown as number | undefined;
    const text = tagNumber === UTF8_TAG ? forge.util.decodeUtf8(raw) : raw;
    return `${keyword}=${escapeRfc2253(text)}`;
  }
  const tag = (attr.valueTagClass as unknown as number) ?? forge.asn1.Type.PRINTABLESTRING;
  const der = forge.asn1.toDer(forge.asn1.create(forge.asn1.Class.UNIVERSAL, tag, false, raw));
  return `${oid}=#${der.toHex()}`;
}

/** Attributes in reverse order of the ASN.1 sequence, joined with commas. */
function formatName(attributes: forge.pki.CertificateField[]): string {
  return [...attributes].reverse().map(formatAttribute).join(',');
}

function digitRuns(text: string, into: Set<string>): void {
  for (const run of text.match(/\d+/g) ?? []) {
    if (run.length === 10 || run.length === 13) into.add(run);
  }
}

/** Collects the string leaves of a DER value so length/tag bytes cannot fake digits. */
function collectAsn1Text(node: forge.asn1.Asn1, into: Set<string>): void {
  if (Array.isArray(node.value)) {
    node.value.forEach((child) => collectAsn1Text(child, into));
  } else if (typeof node.value === 'string') {
    digitRuns(node.value, into);
  }
}

function extractIdentifiers(cert: forge.pki.Certificate): string[] {
  const found = new Set<string>();
  for (const attr of cert.subject.attributes) {
    if (typeof attr.value === 'string') digitRuns(attr.value, found);
  }
  for (const ext of cert.extensions as Array<{ id?: string; value?: unknown }>) {
    const id = ext.id;
    if (!id || typeof ext.value !== 'string') continue;
    if (!IDENTIFIER_EXTENSION_ARCS.some((arc) => id === arc || id.startsWith(`${arc}.`))) continue;
    try {
      collectAsn1Text(forge.asn1.fromDer(ext.value), found);
    } catch {
      digitRuns(ext.value, found);
    }
  }
  return [...found];
}

function classifyOpenError(error: unknown): SriError {
  const message = error instanceof Error ? error.message : '';
  // Only the two messages forge raises for a wrong password; every other forge
  // failure (unsupported MAC/KDF/OID, malformed structure) is a bad file.
  if (
    message.startsWith('PKCS#12 MAC could not be verified') ||
    message === 'Failed to decrypt PKCS#12 SafeContents.'
  ) {
    return new SriError('configuration', 'CERTIFICATE_PASSWORD_INVALID');
  }
  return new SriError('configuration', 'CERTIFICATE_UNREADABLE');
}

export function openCertificate(
  p12: Buffer,
  password: string,
  now: Date = new Date(),
): SigningMaterial {
  let pkcs12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary')));
    pkcs12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (error) {
    throw classifyOpenError(error);
  }

  const keyBags = [
    ...(pkcs12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ] ?? []),
    ...(pkcs12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const privateKey = keyBags
    .map((bag) => bag.key as forge.pki.rsa.PrivateKey | undefined)
    .find((key) => key && key.n && key.d);
  if (!privateKey) throw new SriError('configuration', 'CERTIFICATE_NO_RSA_KEY');

  const certificates = (
    pkcs12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
  )
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => !!cert);
  if (certificates.length === 0) throw new SriError('configuration', 'CERTIFICATE_UNREADABLE');

  const certificate = certificates.find(
    (cert) => (cert.publicKey as forge.pki.rsa.PublicKey).n.compareTo(privateKey.n) === 0,
  );
  if (!certificate) throw new SriError('configuration', 'CERTIFICATE_KEY_MISMATCH');

  const validFrom = certificate.validity.notBefore;
  const validTo = certificate.validity.notAfter;
  if (now.getTime() > validTo.getTime()) throw new SriError('configuration', 'CERTIFICATE_EXPIRED');
  if (now.getTime() < validFrom.getTime())
    throw new SriError('configuration', 'CERTIFICATE_NOT_YET_VALID');

  const certificateDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(),
    'binary',
  );

  return {
    privateKey,
    certificate,
    certificateDer,
    subject: formatName(certificate.subject.attributes),
    issuerName: formatName(certificate.issuer.attributes),
    serial: BigInt(`0x${certificate.serialNumber}`).toString(),
    validFrom,
    validTo,
    sha256: createHash('sha256').update(certificateDer).digest('hex'),
    identifiers: extractIdentifiers(certificate),
  };
}

export function certificateMatchesRuc(
  m: SigningMaterial,
  ruc: string,
): 'MATCH' | 'MISMATCH' | 'UNKNOWN' {
  if (m.identifiers.length === 0) return 'UNKNOWN';
  const cedula = ruc.slice(0, 10);
  return m.identifiers.some((id) => id === ruc || id === cedula) ? 'MATCH' : 'MISMATCH';
}

export function assertCertificateFor(m: SigningMaterial, ruc: string): void {
  if (certificateMatchesRuc(m, ruc) === 'MISMATCH') {
    throw new SriError('configuration', 'CERTIFICATE_RUC_MISMATCH');
  }
}
