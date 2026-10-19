import { ConfigService } from '@nestjs/config';
import { FileStorage, assertStorageKey } from './file-storage';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Keeps files in one private bucket of Supabase Storage, through its HTTP API:
 *
 *   SUPABASE_URL              https://<project>.supabase.co
 *   SUPABASE_SECRET_KEY       secret (or legacy service_role) key; never the publishable one
 *   SUPABASE_STORAGE_BUCKET   a private bucket, without policies
 *
 * The bytes arrive already encrypted, so downloads go through the API and never through a
 * signed URL. The secret key skips the policies of the bucket: it must stay on the server.
 */
export class SupabaseFileStorage implements FileStorage {
  private readonly bucketUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: ConfigService) {
    const required = (name: string) => {
      const value = config.get<string>(name);
      if (!value) throw new Error(`${name} is required when STORAGE_DRIVER is "supabase"`);
      return value;
    };
    let url: URL;
    try {
      url = new URL(required('SUPABASE_URL'));
    } catch {
      throw new Error('SUPABASE_URL must be a valid URL');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const allowLocal =
      loopback &&
      ['test', 'development'].includes(
        config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? '',
      );
    const hosted = /^[a-z0-9]+(?:\.storage)?\.supabase\.co$/.test(url.hostname);
    if (
      (!hosted && !allowLocal) ||
      (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error('SUPABASE_URL must be a Supabase HTTPS origin');
    }
    const secretKey = required('SUPABASE_SECRET_KEY');
    const bucket = required('SUPABASE_STORAGE_BUCKET');
    const opaqueSecret = /^sb_secret_[A-Za-z0-9_-]+$/.test(secretKey);
    const jwtParts = secretKey.split('.');
    let legacyServiceRole = false;
    if (jwtParts.length === 3 && jwtParts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
      try {
        const claims = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8')) as {
          role?: string;
        };
        legacyServiceRole = claims.role === 'service_role';
      } catch {
        // Invalid JWT payloads cannot be used as a service_role key.
      }
    }
    if (!opaqueSecret && !legacyServiceRole) {
      throw new Error('SUPABASE_SECRET_KEY must be an sb_secret_ key or legacy service_role JWT');
    }

    this.bucketUrl = `${url.origin}/storage/v1/object/${encodeURIComponent(bucket)}`;
    // Opaque sb_secret keys are not JWTs. Legacy service_role keys still need Bearer auth.
    this.headers = opaqueSecret
      ? { apikey: secretKey }
      : { apikey: secretKey, Authorization: `Bearer ${secretKey}` };
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.request('POST', this.objectUrl(key), {
      headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' },
      body: new Uint8Array(data),
    });
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.request('GET', this.objectUrl(key));
    return Buffer.from(await response.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    assertStorageKey(key);
    // Answers with the objects it removed; none when the file was already gone.
    await this.request('DELETE', this.bucketUrl, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [key] }),
    });
  }

  private objectUrl(key: string): string {
    assertStorageKey(key);
    return `${this.bucketUrl}/${key}`;
  }

  private async request(
    method: string,
    url: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    const response = await fetch(url, {
      method,
      headers: { ...this.headers, ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const { message } = await response
        .json()
        .then((body: { message?: string } | null) => ({ message: body?.message }))
        .catch(() => ({ message: undefined }));
      throw new Error(
        `Supabase Storage answered ${response.status}${message ? `: ${message}` : ''}`,
      );
    }
    return response;
  }
}
