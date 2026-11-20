import * as forge from 'node-forge';
import { certificateHolderName } from './certificate-holder';
import { formatName } from './certificate';

/** OID=#hex(DER) with the given string tag, as formatName writes unknown attributes. */
function hexAttr(oid: string, text: string, tag = 0x0c): string {
  const content = tag === 0x0c ? Buffer.from(text, 'utf8') : Buffer.from(text, 'latin1');
  return `${oid}=#${Buffer.from([tag, content.length, ...content]).toString('hex')}`;
}

// Same shape as a Security Data "Persona Natural RUC" subject, with fictitious data.
const ECUADORIAN_SUBJECT = [
  'L=SHUSHUFINDI',
  'ST=SUCUMBÍOS',
  hexAttr('2.5.4.13', 'Certificado de firma electrónica'),
  'CN=1712345678 MARÍA JOSÉ PÉREZ ÑAUPARI',
  hexAttr('2.5.4.4', 'PÉREZ ÑAUPARI'),
  hexAttr('2.5.4.5', '1712345678', 0x13),
  'C=EC',
  hexAttr('2.5.4.97', '1712345678001', 0x13),
  hexAttr('2.5.4.42', 'MARÍA JOSÉ'),
  'OU=Certificado Persona Natural RUC EC',
  hexAttr('1.3.6.1.4.1.37442.10.4', '1712345678', 0x0c),
  'O=PÉREZ ÑAUPARI MARÍA JOSÉ',
].join(',');

describe('certificateHolderName', () => {
  it('returns only the holder name from an Ecuadorian subject, without the cédula', () => {
    const name = certificateHolderName(ECUADORIAN_SUBJECT);
    expect(name).toBe('MARÍA JOSÉ PÉREZ ÑAUPARI');
    expect(name).not.toMatch(/\d/);
  });

  it('falls back to givenName + surname decoded from their DER hex when CN is only an id', () => {
    const subject = ECUADORIAN_SUBJECT.replace(
      'CN=1712345678 MARÍA JOSÉ PÉREZ ÑAUPARI',
      'CN=1712345678',
    );
    expect(certificateHolderName(subject)).toBe('MARÍA JOSÉ PÉREZ ÑAUPARI');
  });

  it('falls back to O when there is no usable CN nor given name/surname', () => {
    expect(certificateHolderName('C=EC,O=PÉREZ ÑAUPARI MARÍA JOSÉ,CN=1712345678001')).toBe(
      'PÉREZ ÑAUPARI MARÍA JOSÉ',
    );
  });

  it('drops an identifier placed after the name and collapses spaces', () => {
    expect(certificateHolderName('CN=JUAN   PÉREZ 1712345678001,C=EC')).toBe('JUAN PÉREZ');
  });

  it('keeps escaped separators and decodes \\HH UTF-8 escapes', () => {
    expect(certificateHolderName('CN=CL\\C3\\8DNICA SAN JOS\\C3\\89\\, S.A.,C=EC')).toBe(
      'CLÍNICA SAN JOSÉ, S.A.',
    );
  });

  it('decodes PrintableString and BMPString hex values', () => {
    const bmp = Buffer.from('ÑANDÚ', 'utf16le').swap16();
    const given = `2.5.4.42=#${Buffer.from([0x1e, bmp.length, ...bmp]).toString('hex')}`;
    expect(certificateHolderName(`${hexAttr('2.5.4.4', 'ROJAS', 0x13)},${given}`)).toBe(
      'ÑANDÚ ROJAS',
    );
  });

  it.each([null, undefined, '', 'C=EC,2.5.4.5=#130a31373132333435363738', 'not a dn'])(
    'returns null when the subject names nobody: %p',
    (subject) => expect(certificateHolderName(subject)).toBeNull(),
  );

  it('reads names out of formatName output for real certificate attributes', () => {
    const utf8 = (s: string) => forge.util.encodeUtf8(s);
    const attrs = [
      { type: '2.5.4.8', value: utf8('SUCUMBÍOS'), valueTagClass: forge.asn1.Type.UTF8 },
      { type: '2.5.4.3', value: '1712345678', valueTagClass: forge.asn1.Type.PRINTABLESTRING },
      { type: '2.5.4.4', value: utf8('PÉREZ ÑAUPARI'), valueTagClass: forge.asn1.Type.UTF8 },
      { type: '2.5.4.42', value: utf8('MARÍA JOSÉ'), valueTagClass: forge.asn1.Type.UTF8 },
    ] as unknown as forge.pki.CertificateField[];
    const subject = formatName(attrs);
    expect(subject).toContain('2.5.4.42=#0c');
    expect(certificateHolderName(subject)).toBe('MARÍA JOSÉ PÉREZ ÑAUPARI');
  });
});
