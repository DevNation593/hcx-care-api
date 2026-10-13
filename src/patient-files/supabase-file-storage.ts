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
    const url = required('SUPABASE_URL').replace(/\/+$/, '');
    const secretKey = required('SUPABASE_SECRET_KEY');
    const bucket = required('SUPABASE_STORAGE_BUCKET');

    this.bucketUrl = `${url}/storage/v1/object/${encodeURIComponent(bucket)}`;
    // Both headers, as the official client sends them: the gateway reads one, Storage the other.
    this.headers = { apikey: secretKey, Authorization: `Bearer ${secretKey}` };
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
