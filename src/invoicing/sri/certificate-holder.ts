/**
 * Derives the holder's display name from the certificate subject stored as an RFC 2253 string
 * (see formatName in certificate.ts). Ecuadorian CAs put the holder's cédula or RUC in front of
 * the CN and write givenName/surname as OID=#hex(DER), so the raw subject is not fit to show.
 */

type Ava = { type: string; value: string };

const COMMON_NAME = ['CN', 'COMMONNAME', '2.5.4.3'];
const GIVEN_NAME = ['GIVENNAME', 'G', 'GN', '2.5.4.42'];
const SURNAME = ['SURNAME', 'SN', '2.5.4.4'];
const ORGANIZATION = ['O', 'ORGANIZATIONNAME', '2.5.4.10'];

/** Splits on separators that are not escaped with a backslash. */
function splitUnescaped(text: string, separators: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      current += c + text[i + 1];
      i++;
    } else if (separators.includes(c)) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

/** Reads a single DER string value (tag, length, content) into text. */
function decodeDerString(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const der = Buffer.from(hex, 'hex');
  if (der.length < 2) return null;
  const tag = der[0];
  let length = der[1];
  let offset = 2;
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || der.length < 2 + lengthBytes) return null;
    length = 0;
    for (let i = 0; i < lengthBytes; i++) length = length * 256 + der[2 + i];
    offset = 2 + lengthBytes;
  }
  if (offset + length > der.length) return null;
  const content = der.subarray(offset, offset + length);
  switch (tag) {
    case 0x0c: // UTF8String
      return content.toString('utf8');
    case 0x13: // PrintableString
    case 0x14: // TeletexString
    case 0x16: // IA5String
      return content.toString('latin1');
    case 0x1e: {
      // BMPString: UTF-16BE
      const swapped = Buffer.from(content);
      swapped.swap16();
      return swapped.toString('utf16le');
    }
    default:
      return null;
  }
}

/** Removes RFC 2253 escapes: \X for special characters and \HH for UTF-8 bytes. */
function unescapeValue(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && /^[0-9a-f]{2}$/i.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (c === '\\' && i + 1 < value.length) {
      bytes.push(...Buffer.from(value[i + 1], 'utf8'));
      i++;
    } else {
      bytes.push(...Buffer.from(c, 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseSubject(subject: string): Ava[] {
  const avas: Ava[] = [];
  for (const rdn of splitUnescaped(subject, ',;')) {
    for (const ava of splitUnescaped(rdn, '+')) {
      const eq = ava.indexOf('=');
      if (eq <= 0) continue;
      const type = ava
        .slice(0, eq)
        .trim()
        .toUpperCase()
        .replace(/^OID\./, '');
      const raw = ava.slice(eq + 1).trim();
      const value = raw.startsWith('#') ? decodeDerString(raw.slice(1)) : unescapeValue(raw);
      if (value !== null) avas.push({ type, value });
    }
  }
  return avas;
}

/** Collapses whitespace and drops identifier-like tokens (cédula, RUC, long numbers). */
function cleanName(value: string | undefined): string | null {
  if (!value) return null;
  const name = value
    .split(/\s+/)
    .filter((token) => token && !/^\d{8,}$/.test(token))
    .join(' ');
  return /\p{L}/u.test(name) ? name : null;
}

/**
 * The holder's name: CN without the leading identifier, else givenName + surname, else O.
 * Null when the subject names nobody.
 */
export function certificateHolderName(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const avas = parseSubject(subject);
  const first = (types: string[]) => avas.find((a) => types.includes(a.type))?.value;

  const commonName = cleanName(first(COMMON_NAME));
  if (commonName) return commonName;

  const given = first(GIVEN_NAME);
  const surname = first(SURNAME);
  const fullName = cleanName([given, surname].filter(Boolean).join(' '));
  if (fullName) return fullName;

  return cleanName(first(ORGANIZATION));
}
