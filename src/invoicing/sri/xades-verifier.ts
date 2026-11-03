import { createHash, timingSafeEqual, verify, X509Certificate } from 'crypto';
import { Document, Element, Node as XmlNode } from '@xmldom/xmldom';
import * as forge from 'node-forge';
import { canonicalize, canonicalizeEnveloped, parseXml } from './c14n';
import { formatName } from './certificate';
import { XADES_PROFILE } from './xades-signer';

const { DS, XADES } = XADES_PROFILE;

export interface SignatureVerification {
  valid: boolean;
  /** Stable code of the first failed check; null when valid. */
  reason: string | null;
  /** SHA-256 (hex) of the embedded certificate; only set when the signature is valid. */
  certificateSha256: string | null;
}

const invalid = (reason: string): SignatureVerification => ({
  valid: false,
  reason,
  certificateSha256: null,
});

/** The only descendant with that name, or null when there is not exactly one. */
function single(parent: Element, namespace: string, localName: string): Element | null {
  const nodes = parent.getElementsByTagNameNS(namespace, localName);
  return nodes.length === 1 ? nodes.item(0) : null;
}

function children(parent: Element, namespace: string, localName: string): Element[] {
  const found: Element[] = [];
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    const element = child as Element;
    if (
      child.nodeType === XmlNode.ELEMENT_NODE &&
      element.namespaceURI === namespace &&
      element.localName === localName
    ) {
      found.push(element);
    }
  }
  return found;
}

function onlyChild(parent: Element, namespace: string, localName: string): Element | null {
  const found = children(parent, namespace, localName);
  return found.length === 1 ? found[0] : null;
}

function isInside(node: XmlNode, ancestor: Element): boolean {
  for (let current = node.parentNode; current; current = current.parentNode) {
    if (current === ancestor) return true;
  }
  return false;
}

function base64Bytes(element: Element | null): Buffer {
  return Buffer.from((element?.textContent ?? '').replace(/\s/g, ''), 'base64');
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Elements carrying `value` in an Id, ID or id attribute: a reference must resolve to one. */
function countIds(doc: Document, value: string): number {
  let count = 0;
  const elements = doc.getElementsByTagName('*');
  for (let i = 0; i < elements.length; i++) {
    const element = elements.item(i);
    for (const name of ['Id', 'ID', 'id']) {
      if (element.getAttribute(name) === value) count++;
    }
  }
  return count;
}

interface ProfiledReference {
  target: 'signedProperties' | 'keyInfo' | 'document';
  digestValue: Element;
}

/** Exactly the three references of Annex 14, with their algorithms and no extra transforms. */
function profiledReferences(
  signedInfo: Element,
  signedPropertiesId: string,
  keyInfoId: string,
): ProfiledReference[] | null {
  const algorithm = (parent: Element, localName: string) =>
    onlyChild(parent, DS, localName)?.getAttribute('Algorithm');
  if (
    algorithm(signedInfo, 'CanonicalizationMethod') !== XADES_PROFILE.C14N ||
    algorithm(signedInfo, 'SignatureMethod') !== XADES_PROFILE.RSA_SHA1
  ) {
    return null;
  }
  const references = children(signedInfo, DS, 'Reference');
  if (references.length !== 3) return null;
  const profiled: ProfiledReference[] = [];
  for (const ref of references) {
    const digestValue = onlyChild(ref, DS, 'DigestValue');
    if (!digestValue || algorithm(ref, 'DigestMethod') !== XADES_PROFILE.SHA1) return null;
    const transformsElements = children(ref, DS, 'Transforms');
    const transforms = transformsElements.flatMap((t) => children(t, DS, 'Transform'));
    const uri = ref.getAttribute('URI');
    if (
      uri === `#${signedPropertiesId}` &&
      ref.getAttribute('Type') === XADES_PROFILE.SIGNED_PROPERTIES_TYPE &&
      transformsElements.length === 0
    ) {
      profiled.push({ target: 'signedProperties', digestValue });
    } else if (uri === `#${keyInfoId}` && transformsElements.length === 0) {
      profiled.push({ target: 'keyInfo', digestValue });
    } else if (
      uri === `#${XADES_PROFILE.DOCUMENT_ID}` &&
      transformsElements.length === 1 &&
      transforms.length === 1 &&
      transforms[0].getAttribute('Algorithm') === XADES_PROFILE.ENVELOPED
    ) {
      profiled.push({ target: 'document', digestValue });
    } else {
      return null;
    }
  }
  const targets = new Set(profiled.map((p) => p.target));
  return targets.size === 3 ? profiled : null;
}

/** The KeyInfo certificate must be the one SigningCertificate declares. */
function declaresCertificate(signedProperties: Element, der: Buffer): boolean {
  const certDigest = single(signedProperties, XADES, 'CertDigest');
  const digestMethod = certDigest && single(certDigest, DS, 'DigestMethod');
  const digestValue = certDigest && single(certDigest, DS, 'DigestValue');
  const issuerName = single(signedProperties, DS, 'X509IssuerName');
  const serialNumber = single(signedProperties, DS, 'X509SerialNumber');
  if (!digestMethod || !digestValue || !issuerName || !serialNumber) return false;
  const certificate = forge.pki.certificateFromAsn1(
    forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary'))),
  );
  return (
    digestMethod.getAttribute('Algorithm') === XADES_PROFILE.SHA1 &&
    sameBytes(base64Bytes(digestValue), createHash('sha1').update(der).digest()) &&
    issuerName.textContent === formatName(certificate.issuer.attributes) &&
    serialNumber.textContent.trim() === BigInt(`0x${certificate.serialNumber}`).toString()
  );
}

/** RSAKeyValue must carry the certificate's own key. */
function keyValueMatches(keyInfo: Element, certificate: X509Certificate): boolean {
  const rsaKeyValue = single(keyInfo, DS, 'RSAKeyValue');
  if (!rsaKeyValue) return false;
  const jwk = certificate.publicKey.export({ format: 'jwk' });
  return (
    sameBytes(base64Bytes(single(rsaKeyValue, DS, 'Modulus')), Buffer.from(jwk.n, 'base64url')) &&
    sameBytes(base64Bytes(single(rsaKeyValue, DS, 'Exponent')), Buffer.from(jwk.e, 'base64url'))
  );
}

function check(doc: Document): SignatureVerification {
  const root = doc.documentElement;
  const signatures = doc.getElementsByTagNameNS(DS, 'Signature');
  if (signatures.length !== 1 || signatures.item(0).parentNode !== root) {
    return invalid('SIGNATURE_NOT_UNIQUE');
  }
  const signature = signatures.item(0);
  const signedInfo = onlyChild(signature, DS, 'SignedInfo');
  const signatureValue = onlyChild(signature, DS, 'SignatureValue');
  const keyInfo = onlyChild(signature, DS, 'KeyInfo');
  const signedProperties = single(signature, XADES, 'SignedProperties');
  const certificateElement = single(signature, DS, 'X509Certificate');
  if (
    !signedInfo ||
    !signatureValue ||
    !keyInfo ||
    !signedProperties ||
    !certificateElement ||
    !isInside(certificateElement, keyInfo) ||
    root.getAttribute('id') !== XADES_PROFILE.DOCUMENT_ID
  ) {
    return invalid('SIGNATURE_STRUCTURE_INVALID');
  }
  const signedPropertiesId = signedProperties.getAttribute('Id');
  const keyInfoId = keyInfo.getAttribute('Id');
  if (
    !signedPropertiesId ||
    !keyInfoId ||
    [signedPropertiesId, keyInfoId, XADES_PROFILE.DOCUMENT_ID].some((id) => countIds(doc, id) !== 1)
  ) {
    return invalid('SIGNATURE_STRUCTURE_INVALID');
  }

  const references = profiledReferences(signedInfo, signedPropertiesId, keyInfoId);
  if (!references) return invalid('SIGNATURE_PROFILE_INVALID');

  const der = base64Bytes(certificateElement);
  const certificate = new X509Certificate(der);
  if (!declaresCertificate(signedProperties, der)) return invalid('SIGNING_CERTIFICATE_MISMATCH');
  if (!keyValueMatches(keyInfo, certificate)) return invalid('KEY_VALUE_MISMATCH');

  const canonical = {
    signedProperties: () => canonicalize(signedProperties),
    keyInfo: () => canonicalize(keyInfo),
    document: () => canonicalizeEnveloped(root, signature),
  };
  for (const ref of references) {
    const digest = createHash('sha1').update(canonical[ref.target](), 'utf8').digest();
    if (!sameBytes(digest, base64Bytes(ref.digestValue))) {
      return invalid('REFERENCE_DIGEST_MISMATCH');
    }
  }

  const signedInfoBytes = Buffer.from(canonicalize(signedInfo), 'utf8');
  if (!verify('RSA-SHA1', signedInfoBytes, certificate.publicKey, base64Bytes(signatureValue))) {
    return invalid('SIGNATURE_VALUE_INVALID');
  }
  return {
    valid: true,
    reason: null,
    certificateSha256: createHash('sha256').update(der).digest('hex'),
  };
}

/**
 * Checks that a signed comprobante follows the SRI profile and that its signature is valid with
 * the certificate it carries; port of XadesVerifier.java. It does not check the trust chain or
 * revocation: the SRI does that.
 */
export function verifyInvoiceSignature(signedXml: string): SignatureVerification {
  let doc: Document;
  try {
    doc = parseXml(signedXml);
  } catch {
    return invalid('XML_UNREADABLE');
  }
  try {
    return check(doc);
  } catch {
    return invalid('SIGNATURE_UNEVALUABLE');
  }
}
