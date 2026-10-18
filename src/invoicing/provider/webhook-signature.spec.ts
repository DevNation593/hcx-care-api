import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from './webhook-signature';

describe('verifyWebhookSignature', () => {
  const key = Buffer.from('0123456789abcdef0123456789abcdef');
  const secret = `whsec_${key.toString('base64')}`;
  const now = new Date('2026-10-17T15:00:00Z');
  const timestamp = '1792249200';
  const body = Buffer.from('{ "eventType": "document.authorized", "value": "ñ" }');
  const id = '55555555-5555-4555-8555-555555555555';
  const sign = (payload = body, time = timestamp, signingKey = key) =>
    `v1,${createHmac('sha256', signingKey).update(`${id}.${time}.`).update(payload).digest('base64')}`;
  const headers = (signature = sign(), time = timestamp) => ({
    'webhook-id': id,
    'webhook-timestamp': time,
    'webhook-signature': signature,
  });

  it('uses the decoded whsec key with the exact UTF-8 prefix and raw bytes', () => {
    expect(verifyWebhookSignature(body, headers(), secret, now)).toBe(true);
  });

  it('accepts any valid v1 signature during rotation', () => {
    expect(
      verifyWebhookSignature(
        body,
        headers(`v1,${Buffer.alloc(32).toString('base64')} ${sign()} v2,ignored`),
        secret,
        now,
      ),
    ).toBe(true);
  });

  it('accepts case-insensitive HTTP header names', () => {
    expect(
      verifyWebhookSignature(
        body,
        { 'Webhook-Id': id, 'Webhook-Timestamp': timestamp, 'Webhook-Signature': sign() },
        secret,
        now,
      ),
    ).toBe(true);
  });

  it('rejects modified or JSON-reserialized body bytes', () => {
    expect(
      verifyWebhookSignature(
        Buffer.from(JSON.stringify(JSON.parse(body.toString()))),
        headers(),
        secret,
        now,
      ),
    ).toBe(false);
  });

  it('rejects signing with the literal secret instead of its decoded suffix', () => {
    expect(
      verifyWebhookSignature(
        body,
        headers(sign(body, timestamp, Buffer.from(secret))),
        secret,
        now,
      ),
    ).toBe(false);
  });

  it.each([-301, 301])('rejects timestamps outside the freshness window (%s seconds)', (offset) => {
    const time = String(Number(timestamp) + offset);
    expect(verifyWebhookSignature(body, headers(sign(body, time), time), secret, now)).toBe(false);
  });

  it.each([-300, 300])('accepts the freshness boundary (%s seconds)', (offset) => {
    const time = String(Number(timestamp) + offset);
    expect(verifyWebhookSignature(body, headers(sign(body, time), time), secret, now)).toBe(true);
  });

  it.each(['', 'secret', 'whsec_!!!!', 'whsec_YQ==', `whsec_${key.toString('base64')}garbage`])(
    'fails closed for malformed secrets %#',
    (value) => {
      expect(verifyWebhookSignature(body, headers(), value, now)).toBe(false);
    },
  );

  it.each(['', 'abc', '-1', '1.5', `${timestamp}junk`, '999999999999999999999'])(
    'fails closed for malformed timestamps %#',
    (time) => {
      expect(verifyWebhookSignature(body, headers(sign(body, time), time), secret, now)).toBe(
        false,
      );
    },
  );

  it.each(['', 'v1,!!!!', 'v1,YQ==', 'v2,abcd', `${sign()}junk`])(
    'fails closed for malformed signatures %#',
    (signature) => {
      expect(verifyWebhookSignature(body, headers(signature), secret, now)).toBe(false);
    },
  );

  it('rejects missing or duplicate security headers', () => {
    expect(verifyWebhookSignature(body, {}, secret, now)).toBe(false);
    expect(
      verifyWebhookSignature(body, { ...headers(), 'webhook-id': [id, id] }, secret, now),
    ).toBe(false);
  });
});
