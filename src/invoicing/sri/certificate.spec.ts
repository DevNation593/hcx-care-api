import { SriError } from './sri-types';
import { assertCertificateFor, certificateMatchesRuc, openCertificate } from './certificate';
import { createTestP12 } from './testing/test-certificate';

describe('certificate', () => {
  it('opens a legacy 3DES p12 and reads its metadata', () => {
    const m = openCertificate(createTestP12(), 'clave-prueba');
    expect(m.serial).toMatch(/^\d+$/);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.certificateDer.length).toBeGreaterThan(100);
    expect(m.identifiers).toEqual(['1790012345001']);
    expect(certificateMatchesRuc(m, '1790012345001')).toBe('MATCH');
  });

  it('opens an OpenSSL 3 style AES-256 p12', () =>
    expect(() =>
      openCertificate(createTestP12({ algorithm: 'aes256' }), 'clave-prueba'),
    ).not.toThrow());

  it('picks the certificate that belongs to the private key when the p12 carries a chain', () => {
    const m = openCertificate(createTestP12({ withChain: true }), 'clave-prueba');
    expect(m.certificate.publicKey).toMatchObject({ n: m.privateKey.n });
    expect(m.subject).toContain('TITULAR DE PRUEBA');
  });

  it('writes the issuer name like Java X500Principal.getName() (RFC 2253, reversed)', () => {
    const m = openCertificate(createTestP12({ withChain: true }), 'clave-prueba');
    expect(m.issuerName).toBe('C=EC,O=CA DE PRUEBA,CN=AUTORIDAD CERTIFICADORA DE PRUEBA');
  });

  it('renders attributes without a RFC 2253 keyword as OID=#hex(DER)', () => {
    const m = openCertificate(createTestP12(), 'clave-prueba');
    // serialNumber (2.5.4.5) only appears in the subject, formatted with the same routine.
    expect(m.subject).toBe(
      `2.5.4.5=#${Buffer.from([0x13, 13, ...Buffer.from('1790012345001')]).toString('hex')},C=EC,O=CONSULTORIO DE PRUEBA,CN=TITULAR DE PRUEBA`,
    );
  });

  it.each([
    [{ password: 'otra' }, 'CERTIFICATE_PASSWORD_INVALID'],
    [
      { validTo: new Date(Date.now() - 86400000), validFrom: new Date(Date.now() - 2 * 86400000) },
      'CERTIFICATE_EXPIRED',
    ],
    [
      { validFrom: new Date(Date.now() + 86400000), validTo: new Date(Date.now() + 2 * 86400000) },
      'CERTIFICATE_NOT_YET_VALID',
    ],
  ])('rejects %o', (opts, code) => {
    const open = (opts as { password?: string }).password ?? 'clave-prueba';
    const p12 = createTestP12({ ...opts, password: 'clave-prueba' });
    expect(() => openCertificate(p12, open)).toThrow(
      expect.objectContaining({ kind: 'configuration', code }),
    );
  });

  it('rejects bytes that are not a p12', () => {
    let error: unknown;
    try {
      openCertificate(Buffer.from('nope'), 'x');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SriError);
    expect(error).toMatchObject({ kind: 'configuration', code: 'CERTIFICATE_UNREADABLE' });
  });

  it('matches a natural person RUC by its cédula', () =>
    expect(
      certificateMatchesRuc(
        openCertificate(createTestP12({ ruc: '1710034065' }), 'clave-prueba'),
        '1710034065001',
      ),
    ).toBe('MATCH'));

  it('reports a different RUC as mismatch and no identifier as unknown', () => {
    expect(
      certificateMatchesRuc(
        openCertificate(createTestP12({ ruc: '0990012345001' }), 'clave-prueba'),
        '1790012345001',
      ),
    ).toBe('MISMATCH');
    const unknown = openCertificate(createTestP12({ identifierInSubject: false }), 'clave-prueba');
    expect(unknown.identifiers).toEqual([]);
    expect(certificateMatchesRuc(unknown, '1790012345001')).toBe('UNKNOWN');
  });

  it('assertCertificateFor throws CERTIFICATE_RUC_MISMATCH only on a mismatch', () => {
    const m = openCertificate(createTestP12(), 'clave-prueba');
    expect(() => assertCertificateFor(m, '1790012345001')).not.toThrow();
    expect(() => assertCertificateFor(m, '0990012345001')).toThrow(
      expect.objectContaining({ kind: 'configuration', code: 'CERTIFICATE_RUC_MISMATCH' }),
    );
    const unknown = openCertificate(createTestP12({ identifierInSubject: false }), 'clave-prueba');
    expect(() => assertCertificateFor(unknown, '1790012345001')).not.toThrow();
  });
});
