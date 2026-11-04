import { buildAccessKey, isValidAccessKey, newNumericCode } from './access-key';

const base = {
  issueDate: '2026-10-07',
  ruc: '1790012345001',
  environment: '1' as const,
  establishmentCode: '001',
  emissionPointCode: '002',
  sequential: 123,
  numericCode: '12345678',
};

describe('access key', () => {
  it('builds the 49-digit key with its mod-11 check digit', () => {
    expect(buildAccessKey(base)).toBe('0710202601179001234500110010020000001231234567816');
  });

  it('validates keys', () => {
    expect(isValidAccessKey('0710202601179001234500110010020000001231234567816')).toBe(true);
    expect(isValidAccessKey('0710202601179001234500110010020000001231234567817')).toBe(false);
    expect(isValidAccessKey('0710202601179001234500110010020000001241234567816')).toBe(false);
    expect(isValidAccessKey('123')).toBe(false);
  });

  it('maps a remainder of 11 to 0 and of 10 to 1', () => {
    const digits = new Set<string>();
    for (let sequential = 1; sequential <= 200; sequential++) {
      const key = buildAccessKey({ ...base, sequential });
      expect(key).toMatch(/^\d{49}$/);
      expect(isValidAccessKey(key)).toBe(true);
      digits.add(key[48]);
    }
    // every check digit is a single digit and both special cases are exercised
    expect([...digits].every((d) => /^[0-9]$/.test(d))).toBe(true);
    expect(digits.has('0')).toBe(true);
    expect(digits.has('1')).toBe(true);
  });

  it('rejects malformed parts', () => {
    expect(() => buildAccessKey({ ...base, establishmentCode: '1' })).toThrow();
    expect(() => buildAccessKey({ ...base, sequential: 1_000_000_000 })).toThrow();
    expect(() => buildAccessKey({ ...base, ruc: '123' })).toThrow();
    expect(() => buildAccessKey({ ...base, numericCode: '1234' })).toThrow();
    expect(() => buildAccessKey({ ...base, issueDate: '07/10/2026' })).toThrow();
  });

  it('creates 8-digit numeric codes', () => {
    expect(newNumericCode()).toMatch(/^\d{8}$/);
  });
});
