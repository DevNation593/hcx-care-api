import { createHash, generateKeyPairSync } from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import * as forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { canonicalize } from './c14n';
import { openCertificate, SigningMaterial } from './certificate';
import { buildInvoiceXml } from './invoice-xml';
import { createTestP12 } from './testing/test-certificate';
import { sampleDocument } from './testing/sample-document';
import { validateInvoiceXsd } from './testing/xsd';
import { rsaSha1, signInvoiceXml } from './xades-signer';
import { verifyInvoiceSignature } from './xades-verifier';

const DS = 'http://www.w3.org/2000/09/xmldsig#';
const ETSI = 'http://uri.etsi.org/01903/v1.3.2#';

const material = openCertificate(createTestP12(), 'clave-prueba');
const SIGNING_TIME = new Date('2026-10-07T15:15:30.456Z');
const unsigned = () => buildInvoiceXml(sampleDocument());
const signed = () => signInvoiceXml(unsigned(), material, SIGNING_TIME);

/** Independent check: xml-crypto verifies with the certificate we give it, never KeyInfo. */
function checkWithXmlCrypto(xml: string, m: SigningMaterial): boolean {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const signature = doc.getElementsByTagNameNS(DS, 'Signature').item(0);
  const verifier = new SignedXml({
    publicCert: forge.pki.certificateToPem(m.certificate),
    getCertFromKeyInfo: () => null,
  });
  // Default id attributes are Id, ID and id: they cover the SignedProperties/KeyInfo Ids and
  // the root's id="comprobante".
  expect(verifier.idAttributes).toEqual(expect.arrayContaining(['Id', 'id']));
  verifier.loadSignature(signature as unknown as Node);
  const valid = verifier.checkSignature(xml);
  return valid && verifier.getSignedReferences().length === 3;
}

function only(doc: ReturnType<DOMParser['parseFromString']>, ns: string, localName: string) {
  const nodes = doc.getElementsByTagNameNS(ns, localName);
  expect(nodes.length).toBe(1);
  return nodes.item(0);
}

describe('XAdES-BES signature', () => {
  it('produces a signature our verifier and xml-crypto both accept', () => {
    expect(verifyInvoiceSignature(signed())).toEqual({
      valid: true,
      reason: null,
      certificateSha256: material.sha256,
    });
    expect(checkWithXmlCrypto(signed(), material)).toBe(true);
  });

  it('follows Anexo 14', () => {
    const xml = signed();
    expect(xml.endsWith('</ds:Signature></factura>')).toBe(true);
    expect(xml).toContain(
      '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></ds:CanonicalizationMethod>',
    );
    expect(xml).toContain('Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"');
    expect(xml).toContain('Type="http://uri.etsi.org/01903#SignedProperties"');
    expect(xml).toContain('<etsi:SigningTime>2026-10-07T10:15:30-05:00</etsi:SigningTime>');
    expect(xml).toContain(
      '<etsi:Description>contenido comprobante</etsi:Description><etsi:MimeType>text/xml</etsi:MimeType>',
    );
    expect(xml.match(/<ds:Reference /g)).toHaveLength(3);
    expect(xml).toMatch(/<ds:SignatureValue[^>]*>[A-Za-z0-9+/=]+<\/ds:SignatureValue>/);
  });

  it('links ids, certificate and key exactly as XadesBesSigner.java does', () => {
    const doc = new DOMParser().parseFromString(signed(), 'text/xml');
    const root = doc.documentElement;
    const signature = only(doc, DS, 'Signature');
    expect(root.lastChild).toBe(signature);
    expect(signature.getAttribute('xmlns:ds')).toBe(DS);
    const signatureId = signature.getAttribute('Id');
    expect(signatureId).toMatch(/^Signature\d{6}$/);
    expect(only(doc, DS, 'SignedInfo').getAttribute('Id')).toMatch(/^Signature-SignedInfo\d{6}$/);
    expect(only(doc, DS, 'SignatureValue').getAttribute('Id')).toMatch(/^SignatureValue\d{6}$/);

    const keyInfo = only(doc, DS, 'KeyInfo');
    expect(keyInfo.getAttribute('Id')).toMatch(/^Certificate\d{6}$/);
    const signedProperties = only(doc, ETSI, 'SignedProperties');
    expect(signedProperties.getAttribute('Id')).toMatch(
      new RegExp(`^${signatureId}-SignedProperties\\d{6}$`),
    );
    const qualifying = only(doc, ETSI, 'QualifyingProperties');
    expect(qualifying.getAttribute('xmlns:etsi')).toBe(ETSI);
    expect(qualifying.getAttribute('Target')).toBe(`#${signatureId}`);
    expect((qualifying.parentNode as unknown as Element).getAttribute('Id')).toMatch(
      new RegExp(`^${signatureId}-Object\\d{6}$`),
    );

    const references = only(doc, DS, 'SignedInfo').getElementsByTagNameNS(DS, 'Reference');
    expect(references.length).toBe(3);
    const [toProperties, toKeyInfo, toDocument] = [0, 1, 2].map((i) => references.item(i));
    expect(toProperties.getAttribute('Id')).toMatch(/^SignedPropertiesID\d{6}$/);
    expect(toProperties.getAttribute('URI')).toBe(`#${signedProperties.getAttribute('Id')}`);
    expect(toProperties.getElementsByTagNameNS(DS, 'Transform').length).toBe(0);
    expect(toKeyInfo.hasAttribute('Id')).toBe(false);
    expect(toKeyInfo.getAttribute('URI')).toBe(`#${keyInfo.getAttribute('Id')}`);
    expect(toKeyInfo.getElementsByTagNameNS(DS, 'Transform').length).toBe(0);
    expect(toDocument.getAttribute('Id')).toMatch(/^Reference-ID-\d{6}$/);
    expect(toDocument.getAttribute('URI')).toBe('#comprobante');
    const transforms = toDocument.getElementsByTagNameNS(DS, 'Transform');
    expect(transforms.length).toBe(1);
    expect(transforms.item(0).getAttribute('Algorithm')).toBe(`${DS}enveloped-signature`);
    const digestMethods = doc.getElementsByTagNameNS(DS, 'DigestMethod');
    expect(digestMethods.length).toBe(4);
    for (let i = 0; i < digestMethods.length; i++) {
      expect(digestMethods.item(i).getAttribute('Algorithm')).toBe(`${DS}sha1`);
    }

    expect(only(doc, DS, 'X509Certificate').textContent).toBe(
      material.certificateDer.toString('base64'),
    );
    expect(only(doc, DS, 'Exponent').textContent).toBe('AQAB');
    const modulus = Buffer.from(only(doc, DS, 'Modulus').textContent, 'base64');
    expect(modulus.length).toBe(256);
    expect(modulus.toString('hex')).toBe(material.certificate.publicKey['n'].toString(16));

    const certDigest = only(doc, ETSI, 'CertDigest')
      .getElementsByTagNameNS(DS, 'DigestValue')
      .item(0);
    expect(certDigest.textContent).toBe(
      createHash('sha1').update(material.certificateDer).digest('base64'),
    );
    expect(only(doc, DS, 'X509IssuerName').textContent).toBe(material.issuerName);
    expect(only(doc, DS, 'X509SerialNumber').textContent).toBe(material.serial);
    expect(only(doc, ETSI, 'DataObjectFormat').getAttribute('ObjectReference')).toBe(
      `#${toDocument.getAttribute('Id')}`,
    );
  });

  it('leaves the invoice itself untouched and keeps the XML declaration', () => {
    const xml = signed();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante"')).toBe(
      true,
    );
    expect(xml.replace(/<ds:Signature [\s\S]*<\/ds:Signature>/, '')).toBe(unsigned());
  });

  it('draws fresh six-digit ids on every signature', () => {
    const id = (xml: string) => /<ds:Signature [^>]*Id="(Signature\d{6})"/.exec(xml)?.[1];
    expect(id(signed())).not.toBe(id(signed()));
  });

  it.each([
    ['comprobante', (x: string) => x.replace('<importeTotal>47.48<', '<importeTotal>47.49<')],
    [
      'signed properties',
      (x: string) => x.replace('2026-10-07T10:15:30-05:00', '2026-10-07T10:15:31-05:00'),
    ],
    ['key info', (x: string) => x.replace(/<ds:Exponent>[^<]+</, '<ds:Exponent>AQAA<')],
    // Base64 ignores the line break, so only the KeyInfo digest can notice it.
    ['key info bytes', (x: string) => x.replace(/(<ds:X509Certificate>.{20})/, '$1\n')],
    // Not digested by any reference: only the SignatureValue covers it.
    ['signed info', (x: string) => x.replace('Id="SignedPropertiesID', 'Id="SignedPropertiesIX')],
  ])('detects tampering of the %s', (_, tamper) => {
    const xml = signed();
    expect(tamper(xml)).not.toBe(xml);
    expect(verifyInvoiceSignature(tamper(xml)).valid).toBe(false);
  });

  it('reports which check failed', () => {
    const xml = signed();
    expect(
      verifyInvoiceSignature(xml.replace('<importeTotal>47.48<', '<importeTotal>47.49<')),
    ).toEqual({
      valid: false,
      reason: 'REFERENCE_DIGEST_MISMATCH',
      certificateSha256: null,
    });
    expect(verifyInvoiceSignature(xml.replace(/(<ds:X509Certificate>.{20})/, '$1\n')).reason).toBe(
      'REFERENCE_DIGEST_MISMATCH',
    );
    const value = /<ds:SignatureValue[^>]*>([^<]+)</.exec(xml)[1];
    const flipped = (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
    expect(verifyInvoiceSignature(xml.replace(value, flipped)).reason).toBe(
      'SIGNATURE_VALUE_INVALID',
    );
    expect(verifyInvoiceSignature(unsigned()).reason).toBe('SIGNATURE_NOT_UNIQUE');
    expect(verifyInvoiceSignature('<factura').reason).toBe('XML_UNREADABLE');
  });

  it('rejects a signature made with a key other than the certificate one', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const other = forge.pki.privateKeyFromPem(
      privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    ) as forge.pki.rsa.PrivateKey;
    const xml = signInvoiceXml(unsigned(), { ...material, privateKey: other }, SIGNING_TIME);
    expect(verifyInvoiceSignature(xml).reason).toBe('SIGNATURE_VALUE_INVALID');
  });

  it('rejects a signature moved out of the root', () => {
    const xml = signed();
    const start = xml.indexOf('<ds:Signature ');
    const end = xml.indexOf('</ds:Signature>') + '</ds:Signature>'.length;
    const moved =
      xml.slice(0, start).replace('</infoFactura>', `${xml.slice(start, end)}</infoFactura>`) +
      xml.slice(end);
    expect(verifyInvoiceSignature(moved)).toMatchObject({
      valid: false,
      reason: 'SIGNATURE_NOT_UNIQUE',
    });
  });

  it('rejects a document type declaration', () => {
    const xml = signed().replace('<factura ', '<!DOCTYPE factura><factura ');
    expect(verifyInvoiceSignature(xml).reason).toBe('XML_UNREADABLE');
  });

  it('signs and verifies special characters', () => {
    const doc = sampleDocument();
    const xml = signInvoiceXml(
      buildInvoiceXml({
        ...doc,
        customer: { ...doc.customer, name: `Ñandú & Hijos <"S.A."> 'O'Brien' ✅ 😀\ttab` },
      }),
      material,
      SIGNING_TIME,
    );
    expect(verifyInvoiceSignature(xml).valid).toBe(true);
    expect(checkWithXmlCrypto(xml, material)).toBe(true);
  });

  it('computes the same SignatureValue as forge md.sha1 + privateKey.sign', () => {
    const data =
      '<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">Ñandú ✅</ds:SignedInfo>';
    const md = forge.md.sha1.create();
    md.update(data, 'utf8');
    const expected = Buffer.from(material.privateKey.sign(md), 'binary').toString('base64');
    expect(rsaSha1(data, material.privateKey)).toBe(expected);
  });

  it('keeps the signed invoice valid against the XSD', async () => {
    expect(await validateInvoiceXsd(signed())).toEqual({ valid: true, errors: [] });
  });

  it('refuses to sign twice or a root without id="comprobante"', () => {
    expect(() => signInvoiceXml(signed(), material, new Date())).toThrow();
    expect(() =>
      signInvoiceXml('<factura version="1.1.0"></factura>', material, new Date()),
    ).toThrow();
    expect(() => signInvoiceXml('<factura', material, new Date())).toThrow();
  });
});

describe('canonicalize', () => {
  it('carries the namespaces declared on ancestors, as inclusive C14N requires', () => {
    const doc = new DOMParser().parseFromString(
      '<r xmlns="urn:d" xmlns:a="urn:a"><a:p xmlns:b="urn:b" z="1" b:y="2"><c xmlns:a="urn:a2"/></a:p></r>',
      'text/xml',
    );
    const p = doc.getElementsByTagNameNS('urn:a', 'p').item(0);
    expect(canonicalize(p)).toBe(
      '<a:p xmlns="urn:d" xmlns:a="urn:a" xmlns:b="urn:b" z="1" b:y="2"><c xmlns:a="urn:a2"></c></a:p>',
    );
  });
});
