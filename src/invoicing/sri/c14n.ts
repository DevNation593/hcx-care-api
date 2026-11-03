import { Document, DOMParser, Element, Node as XmlNode } from '@xmldom/xmldom';
import { C14nCanonicalization } from 'xml-crypto';

export const C14N_ALGORITHM = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

const c14n = new C14nCanonicalization();

/**
 * Namespace bindings in scope at `element` that come from its ancestors, nearest declaration
 * first. Inclusive C14N renders all of them on the apex of a document subset, which is what
 * a verifier (the SRI's included) computes when it canonicalizes the element inside the document.
 */
function ancestorNamespaces(element: Element): { prefix: string; namespaceURI: string }[] {
  const bindings = new Map<string, string>();
  for (let node = element.parentNode; node; node = node.parentNode) {
    if (node.nodeType !== XmlNode.ELEMENT_NODE) break;
    const attributes = (node as Element).attributes;
    for (let i = 0; i < attributes.length; i++) {
      const attribute = attributes.item(i);
      const prefix =
        attribute.prefix === 'xmlns' ? attribute.localName : attribute.name === 'xmlns' ? '' : null;
      if (prefix !== null && prefix !== 'xml' && !bindings.has(prefix)) {
        bindings.set(prefix, attribute.value);
      }
    }
  }
  return [...bindings]
    .filter(([prefix, namespaceURI]) => prefix !== '' || namespaceURI !== '')
    .map(([prefix, namespaceURI]) => ({ prefix, namespaceURI }));
}

/** Inclusive C14N (without comments) of `element` as it sits in its document. */
export function canonicalize(element: Element): string {
  return c14n.process(element as unknown as Node, {
    ancestorNamespaces: ancestorNamespaces(element),
  });
}

/**
 * `canonicalize(element)` after the enveloped-signature transform: the same subset without
 * `signature` (a descendant of `element`).
 */
export function canonicalizeEnveloped(element: Element, signature: Element): string {
  let inside = false;
  for (let node: XmlNode = signature.parentNode; node; node = node.parentNode) {
    if (node === element) inside = true;
  }
  if (!inside) throw new Error('The signature is not inside the element');
  // Detached only while canonicalizing, so the element keeps its real ancestors.
  const parent = signature.parentNode;
  const next = signature.nextSibling;
  parent.removeChild(signature);
  try {
    return canonicalize(element);
  } finally {
    parent.insertBefore(signature, next);
  }
}

/** Parses XML strictly: any parse error throws, and DOCTYPE (entities) is refused. */
export function parseXml(xml: string): Document {
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw new Error(message);
    },
  }).parseFromString(xml, 'text/xml');
  if (doc.doctype || !doc.documentElement) throw new Error('Unsupported XML document');
  return doc;
}
