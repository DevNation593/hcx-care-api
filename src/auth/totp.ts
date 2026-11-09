import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226): HMAC-SHA1, 6 digits, 30-second steps,
 * the parameters every authenticator app uses by default. Secrets travel as base32 (RFC 4648).
 */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted before and after the current one, for clocks a little off. */
export const TOTP_WINDOW = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A new random secret of 160 bits, base32. */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);

/** The code of one step (HOTP with the step as counter). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The step a code belongs to, within the window around `at`, or null. The caller must reject a
 * step not later than the last one it accepted, so a code is never used twice.
 */
export function matchTotp(secret: string, code: string, at: Date = new Date()): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const current = totpStep(at);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const expected = totpCode(secret, current + delta);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return current + delta;
  }
  return null;
}

/** What authenticator apps read from the QR code. */
export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten single-use recovery codes like "k7qm-2xdp", shown once; only their hashes are stored. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(5)).toLowerCase().slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

export const hashRecoveryCode = (code: string) =>
  createHash('sha256').update(code.replace(/[\s-]/g, '').toLowerCase()).digest('hex');
