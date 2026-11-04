import { generateKeyPairSync, randomBytes } from 'crypto';
import * as forge from 'node-forge';

export interface TestP12Options {
  ruc?: string;
  password?: string;
  validFrom?: Date;
  validTo?: Date;
  algorithm?: '3des' | 'aes256';
  /** Adds a self-signed CA certificate that signed the leaf, placed BEFORE the leaf. */
  withChain?: boolean;
  /** When false the subject carries no 10/13-digit identifier at all. */
  identifierInSubject?: boolean;
}

interface ForgeKeyPair {
  privateKey: forge.pki.rsa.PrivateKey;
  publicKey: forge.pki.rsa.PublicKey;
}

// RSA generation is slow: cache one leaf and one CA pair per process.
const keyCache: ForgeKeyPair[] = [];

function cachedKeyPair(slot: number): ForgeKeyPair {
  if (!keyCache[slot]) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const forgePrivate = forge.pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey;
    keyCache[slot] = {
      privateKey: forgePrivate,
      publicKey: forge.pki.setRsaPublicKey(forgePrivate.n, forgePrivate.e),
    };
  }
  return keyCache[slot];
}

function randomSerial(): string {
  // Leading 01 keeps the DER integer positive.
  return `01${randomBytes(8).toString('hex')}`;
}

/** Builds an in-memory PKCS#12 holding a freshly signed test certificate. */
export function createTestP12(opts: TestP12Options = {}): Buffer {
  const password = opts.password ?? 'clave-prueba';
  const ruc = opts.ruc ?? '1790012345001';
  const now = new Date();
  const validFrom = opts.validFrom ?? now;
  const validTo = opts.validTo ?? new Date(now.getTime() + 365 * 86400000);

  const leafKeys = cachedKeyPair(0);
  const caKeys = cachedKeyPair(1);

  const caAttrs = [
    { name: 'commonName', value: 'AUTORIDAD CERTIFICADORA DE PRUEBA' },
    { name: 'organizationName', value: 'CA DE PRUEBA' },
    { name: 'countryName', value: 'EC' },
  ];

  const leafAttrs: forge.pki.CertificateField[] = [
    { name: 'commonName', value: 'TITULAR DE PRUEBA' },
    { name: 'organizationName', value: 'CONSULTORIO DE PRUEBA' },
    { name: 'countryName', value: 'EC' },
  ];
  if (opts.identifierInSubject !== false) {
    leafAttrs.push({ type: '2.5.4.5', value: ruc });
  }

  const build = (
    publicKey: forge.pki.rsa.PublicKey,
    subject: forge.pki.CertificateField[],
    issuer: forge.pki.CertificateField[],
    signingKey: forge.pki.rsa.PrivateKey,
  ) => {
    const cert = forge.pki.createCertificate();
    cert.publicKey = publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = validFrom;
    cert.validity.notAfter = validTo;
    cert.setSubject(subject);
    cert.setIssuer(issuer);
    cert.sign(signingKey, forge.md.sha256.create());
    return cert;
  };

  const caCert = build(caKeys.publicKey, caAttrs, caAttrs, caKeys.privateKey);
  const leafCert = build(
    leafKeys.publicKey,
    leafAttrs,
    opts.withChain ? caAttrs : leafAttrs,
    opts.withChain ? caKeys.privateKey : leafKeys.privateKey,
  );

  const chain = opts.withChain ? [caCert, leafCert] : [leafCert];
  const asn1 = forge.pkcs12.toPkcs12Asn1(leafKeys.privateKey, chain, password, {
    algorithm: opts.algorithm ?? '3des',
    generateLocalKeyId: true,
    friendlyName: 'test',
  });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}
