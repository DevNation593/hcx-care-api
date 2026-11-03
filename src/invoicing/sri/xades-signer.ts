import { createHash, createPrivateKey, randomInt, sign } from 'crypto';
import { Document, Element, Node as XmlNode, XMLSerializer } from '@xmldom/xmldom';
import * as forge from 'node-forge';
import { C14N_ALGORITHM, canonicalize, canonicalizeEnveloped, parseXml } from './c14n';
import { SigningMaterial } from './certificate';
import { SriError } from './sri-types';

/**
 * Signature parameters fixed by the SRI technical sheet v2.34 (section 6 and Annex 14), as in
 * XadesProfile.java. SHA-1 is cryptographically weak, but it is what the SRI requires.
 */
export const XADES_PROFILE = {
  DS: 'http://www.w3.org/2000/09/xmldsig#',
  XADES: 'http://uri.etsi.org/01903/v1.3.2#',
  C14N: C14N_ALGORITHM,
  RSA_SHA1: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  SHA1: 'http://www.w3.org/2000/09/xmldsig#sha1',
  ENVELOPED: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
  SIGNED_PROPERTIES_TYPE: 'http://uri.etsi.org/01903#SignedProperties',
  /** id of every comprobante root, and target of the document reference. */
  DOCUMENT_ID: 'comprobante',
} as const;

const { DS, XADES } = XADES_PROFILE;
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
/** Ecuador is UTC-5 all year. */
const ECUADOR_OFFSET_MS = -5 * 3600000;

function sha1Base64(data: string | Buffer): string {
  return createHash('sha1').update(data).digest('base64');
}

/** Magnitude without a sign byte, as the XMLDSig CryptoBinary type requires. */
function cryptoBinary(value: forge.jsbn.BigInteger): string {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex').toString('base64');
}

/** ISO offset date-time in Ecuador, truncated to seconds: 2026-10-07T10:15:30-05:00. */
function signingTimeText(time: Date): string {
  const seconds = Math.floor(time.getTime() / 1000) * 1000;
  return `${new Date(seconds + ECUADOR_OFFSET_MS).toISOString().slice(0, 19)}-05:00`;
}

/**
 * RSASSA-PKCS1-v1_5 with SHA-1, base64 in one line. Deterministic, so it equals forge's
 * `privateKey.sign(md.sha1)`; Node's native RSA takes milliseconds where forge's takes seconds.
 */
export function rsaSha1(data: string, privateKey: forge.pki.rsa.PrivateKey): string {
  const key = createPrivateKey(forge.pki.privateKeyToPem(privateKey));
  return sign('RSA-SHA1', Buffer.from(data, 'utf8'), key).toString('base64');
}

/** Random six-digit number used in the element ids, as XadesBesSigner.java draws them. */
function idNumber(): number {
  return randomInt(100000, 1000000);
}

class Builder {
  constructor(private readonly doc: Document) {}

  ds(parent: Element | null, name: string, attributes: Record<string, string> = {}): Element {
    return this.element(parent, DS, `ds:${name}`, attributes);
  }

  etsi(parent: Element | null, name: string, attributes: Record<string, string> = {}): Element {
    return this.element(parent, XADES, `etsi:${name}`, attributes);
  }

  text(element: Element, value: string): Element {
    element.appendChild(this.doc.createTextNode(value));
    return element;
  }

  private element(
    parent: Element | null,
    namespace: string,
    qualifiedName: string,
    attributes: Record<string, string>,
  ): Element {
    const element = this.doc.createElementNS(namespace, qualifiedName);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    parent?.appendChild(element);
    return element;
  }
}

/** Adds a ds:Reference and returns its (empty) DigestValue. */
function reference(
  b: Builder,
  signedInfo: Element,
  attributes: Record<string, string>,
  enveloped: boolean,
): Element {
  const ref = b.ds(signedInfo, 'Reference', attributes);
  if (enveloped) {
    b.ds(b.ds(ref, 'Transforms'), 'Transform', { Algorithm: XADES_PROFILE.ENVELOPED });
  }
  b.ds(ref, 'DigestMethod', { Algorithm: XADES_PROFILE.SHA1 });
  return b.ds(ref, 'DigestValue');
}

/** etsi:QualifyingProperties with the signed properties XAdES-BES asks for. */
function qualifyingProperties(
  b: Builder,
  object: Element,
  material: SigningMaterial,
  signingTime: Date,
  ids: { signature: string; signedProperties: string; documentReference: string },
): Element {
  const qualifying = b.etsi(object, 'QualifyingProperties');
  // Declared on the element itself so signing and verifying canonicalize the same namespaces.
  qualifying.setAttributeNS(XMLNS, 'xmlns:etsi', XADES);
  qualifying.setAttribute('Target', `#${ids.signature}`);

  const signedProperties = b.etsi(qualifying, 'SignedProperties', { Id: ids.signedProperties });
  const signatureProperties = b.etsi(signedProperties, 'SignedSignatureProperties');
  b.text(b.etsi(signatureProperties, 'SigningTime'), signingTimeText(signingTime));
  const cert = b.etsi(b.etsi(signatureProperties, 'SigningCertificate'), 'Cert');
  const certDigest = b.etsi(cert, 'CertDigest');
  b.ds(certDigest, 'DigestMethod', { Algorithm: XADES_PROFILE.SHA1 });
  b.text(b.ds(certDigest, 'DigestValue'), sha1Base64(material.certificateDer));
  const issuerSerial = b.etsi(cert, 'IssuerSerial');
  b.text(b.ds(issuerSerial, 'X509IssuerName'), material.issuerName);
  b.text(b.ds(issuerSerial, 'X509SerialNumber'), material.serial);

  const dataObjectFormat = b.etsi(
    b.etsi(signedProperties, 'SignedDataObjectProperties'),
    'DataObjectFormat',
    { ObjectReference: `#${ids.documentReference}` },
  );
  b.text(b.etsi(dataObjectFormat, 'Description'), 'contenido comprobante');
  b.text(b.etsi(dataObjectFormat, 'MimeType'), 'text/xml');
  return signedProperties;
}

/** Writes empty elements as <x></x>, the form of the SRI's Annex 14 example. */
function expandEmptyElements(doc: Document, element: Element): void {
  if (!element.firstChild) element.appendChild(doc.createTextNode(''));
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === XmlNode.ELEMENT_NODE) expandEmptyElements(doc, child as Element);
  }
}

function serialize(doc: Document): string {
  const first = doc.firstChild;
  if (first?.nodeType === XmlNode.PROCESSING_INSTRUCTION_NODE && first.nodeName === 'xml') {
    doc.removeChild(first);
  }
  return XML_DECLARATION + new XMLSerializer().serializeToString(doc);
}

/**
 * XAdES-BES enveloped signature with the structure of Annex 14 of the SRI technical sheet, a
 * port of XadesBesSigner.java: it covers the comprobante, SignedProperties and the KeyInfo that
 * carries the certificate.
 */
export function signInvoiceXml(xml: string, material: SigningMaterial, signingTime: Date): string {
  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    throw new SriError('data', 'INVOICE_XML_UNREADABLE');
  }
  const root = doc.documentElement;
  if (root.getAttribute('id') !== XADES_PROFILE.DOCUMENT_ID) {
    throw new SriError('data', 'INVOICE_XML_ROOT_ID_MISSING');
  }
  if (doc.getElementsByTagNameNS(DS, 'Signature').length > 0) {
    throw new SriError('data', 'INVOICE_XML_ALREADY_SIGNED');
  }

  const signatureId = `Signature${idNumber()}`;
  const ids = {
    signature: signatureId,
    signedProperties: `${signatureId}-SignedProperties${idNumber()}`,
    keyInfo: `Certificate${idNumber()}`,
    documentReference: `Reference-ID-${idNumber()}`,
  };

  const b = new Builder(doc);
  const signature = b.ds(null, 'Signature');
  signature.setAttributeNS(XMLNS, 'xmlns:ds', DS);
  signature.setAttribute('Id', ids.signature);

  const signedInfo = b.ds(signature, 'SignedInfo', { Id: `Signature-SignedInfo${idNumber()}` });
  b.ds(signedInfo, 'CanonicalizationMethod', { Algorithm: XADES_PROFILE.C14N });
  b.ds(signedInfo, 'SignatureMethod', { Algorithm: XADES_PROFILE.RSA_SHA1 });
  const signedPropertiesDigest = reference(
    b,
    signedInfo,
    {
      Id: `SignedPropertiesID${idNumber()}`,
      Type: XADES_PROFILE.SIGNED_PROPERTIES_TYPE,
      URI: `#${ids.signedProperties}`,
    },
    false,
  );
  const keyInfoDigest = reference(b, signedInfo, { URI: `#${ids.keyInfo}` }, false);
  const documentDigest = reference(
    b,
    signedInfo,
    { Id: ids.documentReference, URI: `#${XADES_PROFILE.DOCUMENT_ID}` },
    true,
  );

  const signatureValue = b.ds(signature, 'SignatureValue', { Id: `SignatureValue${idNumber()}` });

  const publicKey = material.certificate.publicKey as forge.pki.rsa.PublicKey;
  const keyInfo = b.ds(signature, 'KeyInfo', { Id: ids.keyInfo });
  b.text(
    b.ds(b.ds(keyInfo, 'X509Data'), 'X509Certificate'),
    material.certificateDer.toString('base64'),
  );
  const rsaKeyValue = b.ds(b.ds(keyInfo, 'KeyValue'), 'RSAKeyValue');
  b.text(b.ds(rsaKeyValue, 'Modulus'), cryptoBinary(publicKey.n));
  b.text(b.ds(rsaKeyValue, 'Exponent'), cryptoBinary(publicKey.e));

  const object = b.ds(signature, 'Object', { Id: `${signatureId}-Object${idNumber()}` });
  const signedProperties = qualifyingProperties(b, object, material, signingTime, ids);

  // In place before any digest, so canonicalization sees the real in-scope namespaces.
  root.appendChild(signature);

  b.text(signedPropertiesDigest, sha1Base64(canonicalize(signedProperties)));
  b.text(keyInfoDigest, sha1Base64(canonicalize(keyInfo)));
  b.text(documentDigest, sha1Base64(canonicalizeEnveloped(root, signature)));

  b.text(signatureValue, rsaSha1(canonicalize(signedInfo), material.privateKey));

  expandEmptyElements(doc, signature);
  return serialize(doc);
}
