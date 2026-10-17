import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookHeaders = Record<string, string | string[] | undefined>;

function header(headers: WebhookHeaders, name: string): string | undefined {
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (entries.length !== 1 || typeof entries[0][1] !== 'string') return undefined;
  return entries[0][1];
}

function decoded32(value: string): Buffer | undefined {
  if (!/^[A-Za-z\d+/]{43}=$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value ? bytes : undefined;
}

/** Five-minute receiver freshness policy; verify the original bytes before parsing JSON. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  headers: WebhookHeaders,
  secret: string,
  now: Date = new Date(),
): boolean {
  if (
    !Buffer.isBuffer(rawBody) ||
    !headers ||
    typeof secret !== 'string' ||
    !secret.startsWith('whsec_')
  )
    return false;
  const key = decoded32(secret.slice('whsec_'.length));
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (
    !key ||
    !id ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id) ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !signatures ||
    signatures.length > 8192
  )
    return false;
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(seconds) ||
    !Number.isFinite(now.getTime()) ||
    Math.abs(now.getTime() / 1000 - seconds) > 300
  )
    return false;
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest();
  return signatures.split(/\s+/).some((signature) => {
    if (!signature.startsWith('v1,')) return false;
    const digest = decoded32(signature.slice(3));
    return digest !== undefined && timingSafeEqual(digest, expected);
  });
}
