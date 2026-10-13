import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher, parseClinicalKeys } from '../clinical-access/clinical-cipher';
import { PrismaService } from '../prisma/prisma.service';
import { LocalFileStorage } from './file-storage';
import { createFileStorage } from './file-storage.factory';
import { PatientFilesService } from './patient-files.service';
import { SupabaseFileStorage } from './supabase-file-storage';

const SECRET_KEY = 'sb_secret_test-key';
const BUCKET = 'clinical-files';
// Not valid UTF-8: the bytes must arrive as they were sent.
const ENCRYPTED = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x0a, 0x0d, 0xfe, 0x00]);

const configOf = (values: Record<string, string | undefined>) =>
  ({ get: (name: string) => values[name] }) as unknown as ConfigService;

/**
 * The part of the Supabase Storage HTTP API the driver uses, with the routes, headers and
 * error bodies of the real service: an existing object answers 400 with `statusCode: "409"`.
 */
function fakeSupabaseStorage() {
  const objects = new Map<string, Buffer>();
  const requests: { method: string; url: string }[] = [];
  const read = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  const server: Server = createServer(async (request, response) => {
    const { method = '', url = '' } = request;
    requests.push({ method, url });
    const body = await read(request);
    const answer = (status: number, payload: object) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const failure = (status: number, statusCode: string, error: string, message: string) =>
      answer(status, { statusCode, error, message });

    if (
      request.headers.apikey !== SECRET_KEY ||
      request.headers.authorization !== `Bearer ${SECRET_KEY}`
    ) {
      return failure(403, '403', 'Unauthorized', 'Invalid API key');
    }

    const match = /^\/storage\/v1\/object\/([^/]+)(?:\/(.+))?$/.exec(url);
    if (!match) return failure(404, '404', 'Not Found', 'Route not found');
    const [, bucket, objectPath] = match;
    if (bucket !== BUCKET) return failure(400, '404', 'Bucket not found', 'Bucket not found');
    const name = `${bucket}/${objectPath}`;

    if (method === 'POST' && objectPath) {
      if (objects.has(name) && request.headers['x-upsert'] !== 'true') {
        return failure(400, '409', 'Duplicate', 'The resource already exists');
      }
      objects.set(name, body);
      return answer(200, { Key: name, Id: 'object-id' });
    }
    if (method === 'GET' && objectPath) {
      const stored = objects.get(name);
      if (!stored) return failure(400, '404', 'not_found', 'Object not found');
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return response.end(stored);
    }
    if (method === 'DELETE' && !objectPath) {
      const { prefixes } = JSON.parse(body.toString()) as { prefixes: string[] };
      const removed = prefixes.filter((prefix) => objects.delete(`${bucket}/${prefix}`));
      return answer(
        200,
        removed.map((prefix) => ({ name: prefix, bucket_id: bucket })),
      );
    }
    return failure(404, '404', 'Not Found', 'Route not found');
  });

  return {
    objects,
    requests,
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      ),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('SupabaseFileStorage', () => {
  const supabase = fakeSupabaseStorage();
  let settings: Record<string, string>;
  const storageWith = (overrides: Record<string, string | undefined> = {}) =>
    new SupabaseFileStorage(configOf({ ...settings, ...overrides }));

  beforeAll(async () => {
    settings = {
      // As copied from the dashboard, with or without the final slash.
      SUPABASE_URL: `${await supabase.listen()}/`,
      SUPABASE_SECRET_KEY: SECRET_KEY,
      SUPABASE_STORAGE_BUCKET: BUCKET,
    };
  });
  afterAll(() => supabase.close());
  beforeEach(() => {
    supabase.objects.clear();
    supabase.requests.length = 0;
  });

  it('writes, reads and removes a file under its key in the bucket', async () => {
    const storage = storageWith();

    await storage.put('tenant-1/patient-1/file-a', ENCRYPTED);

    expect([...supabase.objects.keys()]).toEqual(['clinical-files/tenant-1/patient-1/file-a']);
    expect(supabase.objects.get('clinical-files/tenant-1/patient-1/file-a')).toEqual(ENCRYPTED);
    expect(await storage.get('tenant-1/patient-1/file-a')).toEqual(ENCRYPTED);

    await storage.remove('tenant-1/patient-1/file-a');
    expect(supabase.objects.size).toBe(0);
  });

  it('never overwrites an existing key', async () => {
    const storage = storageWith();
    await storage.put('tenant-1/patient-1/file-b', ENCRYPTED);

    await expect(storage.put('tenant-1/patient-1/file-b', Buffer.from('other'))).rejects.toThrow(
      'The resource already exists',
    );
    expect(await storage.get('tenant-1/patient-1/file-b')).toEqual(ENCRYPTED);
  });

  it('fails to read a file that is not in the bucket', async () => {
    await expect(storageWith().get('tenant-1/patient-1/missing')).rejects.toThrow(
      'Object not found',
    );
  });

  it('removes what is already gone without an error', async () => {
    await expect(storageWith().remove('tenant-1/patient-1/missing')).resolves.toBeUndefined();
    expect(supabase.requests.map(({ method }) => method)).toEqual(['DELETE']);
  });

  it('removes only the file of that key', async () => {
    const storage = storageWith();
    await storage.put('tenant-1/patient-1/file-c', ENCRYPTED);
    await storage.put('tenant-1/patient-1/file-cd', ENCRYPTED);

    await storage.remove('tenant-1/patient-1/file-c');

    expect([...supabase.objects.keys()]).toEqual(['clinical-files/tenant-1/patient-1/file-cd']);
  });

  it.each(['../outside', 'tenant-1/../../etc/passwd', '/etc/passwd', 'a\\b', 'a//b', '', 'a/.'])(
    'refuses the key %p before calling the service',
    async (bad) => {
      const storage = storageWith();

      await expect(storage.put(bad, ENCRYPTED)).rejects.toThrow('Invalid storage key');
      await expect(storage.get(bad)).rejects.toThrow('Invalid storage key');
      await expect(storage.remove(bad)).rejects.toThrow('Invalid storage key');
      expect(supabase.requests).toEqual([]);
    },
  );

  it('reports a rejected key without revealing it', async () => {
    const storage = storageWith({ SUPABASE_SECRET_KEY: 'sb_secret_wrong' });

    const error = await storage.put('tenant-1/patient-1/file-d', ENCRYPTED).catch((e) => e);

    expect(error.message).toContain('403');
    expect(error.message).not.toContain('sb_secret_wrong');
    expect(supabase.objects.size).toBe(0);
  });

  it('reports a bucket that does not exist', async () => {
    const storage = storageWith({ SUPABASE_STORAGE_BUCKET: 'missing-bucket' });

    await expect(storage.put('tenant-1/patient-1/file-e', ENCRYPTED)).rejects.toThrow(
      'Bucket not found',
    );
    await expect(storage.remove('tenant-1/patient-1/file-e')).rejects.toThrow('Bucket not found');
  });

  it('fails when the service cannot be reached', async () => {
    const storage = storageWith({ SUPABASE_URL: 'http://127.0.0.1:9' });

    await expect(storage.get('tenant-1/patient-1/file-f')).rejects.toThrow();
  });

  it.each(['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_STORAGE_BUCKET'])(
    'cannot be created without %s',
    (name) => {
      expect(() => storageWith({ [name]: '' })).toThrow(name);
    },
  );

  it('holds what the patient files service uploads, encrypted, and returns it for the download', async () => {
    const PDF = Buffer.from('%PDF-1.7\nHemograma: hemoglobina 13,5 g/dL');
    const cipher = new ClinicalCipher(
      parseClinicalKeys(`2026:${randomBytes(32).toString('base64')}`),
    );
    const rows: Record<string, unknown>[] = [];
    const db = {
      patient: { findFirst: async () => ({ id: 'patient-1' }) },
      tenantSubscription: {
        findUnique: async () => ({ storageGB: 1 }),
        updateMany: async () => ({ count: 1 }),
      },
      patientFile: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          rows.push({ id: 'file-1', createdAt: new Date(), deletedAt: null, ...data });
          return rows[0];
        },
        findFirst: async () => rows[0],
      },
      auditLog: { createMany: async () => ({ count: 1 }) },
    };
    const prisma = {
      ...db,
      $transaction: (callback: (tx: unknown) => unknown) => callback(db),
      applyRlsContext: async () => undefined,
    } as unknown as PrismaService;
    const actor: ClinicalActor = { userId: 'dentist', role: 'PROFESIONAL', specialtyId: 'd' };
    const service = new PatientFilesService(
      prisma,
      new ClinicalAuditService(prisma, cipher),
      cipher,
      storageWith(),
    );

    await service.upload(
      'tenant-1',
      'patient-1',
      actor,
      { originalname: 'hemograma.pdf', mimetype: 'application/pdf', size: PDF.length, buffer: PDF },
      { category: 'EXAMEN' } as never,
    );

    const [[name, stored]] = [...supabase.objects];
    expect(name).toMatch(/^clinical-files\/tenant-1\/patient-1\/[0-9a-f-]{36}$/);
    expect(stored.includes(Buffer.from('hemoglobina'))).toBe(false);
    const file = await service.download('tenant-1', 'patient-1', 'file-1', actor);
    expect(file).toEqual({ fileName: 'hemograma.pdf', mimeType: 'application/pdf', data: PDF });
  });
});

describe('createFileStorage', () => {
  const supabaseSettings = {
    STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: SECRET_KEY,
    SUPABASE_STORAGE_BUCKET: BUCKET,
  };

  it('keeps the files on the local disk unless told otherwise', () => {
    expect(createFileStorage(configOf({}))).toBeInstanceOf(LocalFileStorage);
    expect(createFileStorage(configOf({ STORAGE_DRIVER: 'local' }))).toBeInstanceOf(
      LocalFileStorage,
    );
  });

  it('uses the Supabase bucket when it is the chosen driver', () => {
    expect(createFileStorage(configOf(supabaseSettings))).toBeInstanceOf(SupabaseFileStorage);
  });

  it('does not fall back to the local disk when Supabase is chosen but incomplete', () => {
    expect(() =>
      createFileStorage(configOf({ ...supabaseSettings, SUPABASE_STORAGE_BUCKET: undefined })),
    ).toThrow('SUPABASE_STORAGE_BUCKET');
  });

  it('refuses a driver it does not know', () => {
    expect(() => createFileStorage(configOf({ STORAGE_DRIVER: 's3' }))).toThrow('STORAGE_DRIVER');
  });
});
