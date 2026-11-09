import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchTotp,
  otpauthUrl,
  totpCode,
  totpStep,
} from './totp';

// RFC 6238, appendix B: the SHA-1 seed "12345678901234567890". Its codes have 8 digits; the
// 6-digit ones authenticator apps show are their last six.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('round-trips base32 and reads the RFC secret', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('gives the RFC 6238 code at %i seconds', (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(new Date(seconds * 1000)))).toBe(code);
  });

  it('accepts a code of the step before or after, and nothing further', () => {
    const at = new Date(1111111109 * 1000);
    const step = totpStep(at);

    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), at)).toBe(step);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), at)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), at)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), at)).toBeNull();
    expect(matchTotp(RFC_SECRET, '12345', at)).toBeNull();
    expect(matchTotp(RFC_SECRET, 'abcdef', at)).toBeNull();
  });

  it('builds the URL authenticator apps read', () => {
    expect(otpauthUrl('HCX Care', 'ana@example.com', 'ABC')).toBe(
      'otpauth://totp/HCX%20Care%3Aana%40example.com?secret=ABC&issuer=HCX+Care&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('makes ten distinct recovery codes, hashed the same however they are typed', () => {
    const codes = generateRecoveryCodes();

    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(hashRecoveryCode(codes[0].toUpperCase().replace('-', ' '))).toBe(
      hashRecoveryCode(codes[0]),
    );
  });
});
