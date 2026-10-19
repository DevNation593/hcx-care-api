import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import * as path from 'path';
import { ClinicalCipher, parseClinicalKeys } from '../src/clinical-access/clinical-cipher';
import { assertStorageKey, FileStorage, LocalFileStorage } from '../src/patient-files/file-storage';
import { SupabaseFileStorage } from '../src/patient-files/supabase-file-storage';

export type StorageKeyDatabase = Pick<
  PrismaClient,
  'patientFile' | 'consentDocument' | 'consentSignature' | 'invoiceRequest'
>;

export interface StorageCopySummary {
  planned: number;
  bytes: number;
  plaintextSource: number;
  uploaded: number;
  reused: number;
  verified: number;
}

export interface StorageObjectRef {
  key: string;
  tenantId: string;
}

export function assertSupabaseProjectUrl(databaseUrl: string, supabaseUrl: string): void {
  const database = new URL(databaseUrl);
  const projectRef =
    /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(database.username))?.[1] ??
    /^db\.([a-z0-9]+)\.supabase\.co$/.exec(database.hostname)?.[1];
  const storage = new URL(supabaseUrl);
  if (storage.protocol !== 'https:') throw new Error('SUPABASE_URL must use HTTPS');
  if (
    !projectRef ||
    ![`${projectRef}.supabase.co`, `${projectRef}.storage.supabase.co`].includes(storage.hostname)
  ) {
    throw new Error('SUPABASE_URL does not match the database project');
  }
}

export async function collectReferencedStorageKeys(
  database: StorageKeyDatabase,
): Promise<StorageObjectRef[]> {
  const [files, documents, signatures, invoices] = await Promise.all([
    database.patientFile.findMany({ select: { storageKey: true, tenantId: true } }),
    database.consentDocument.findMany({
      where: { pdfStorageKey: { not: null } },
      select: { pdfStorageKey: true, tenantId: true },
    }),
    database.consentSignature.findMany({ select: { signatureStorageKey: true, tenantId: true } }),
    database.invoiceRequest.findMany({
      where: { OR: [{ xmlStorageKey: { not: null } }, { rideStorageKey: { not: null } }] },
      select: { xmlStorageKey: true, rideStorageKey: true, tenantId: true },
    }),
  ]);

  const refs = [
    ...files.map((row) => ({ key: row.storageKey, tenantId: row.tenantId })),
    ...documents.map((row) => ({ key: row.pdfStorageKey, tenantId: row.tenantId })),
    ...signatures.map((row) => ({ key: row.signatureStorageKey, tenantId: row.tenantId })),
    ...invoices.flatMap((row) => [
      { key: row.xmlStorageKey, tenantId: row.tenantId },
      { key: row.rideStorageKey, tenantId: row.tenantId },
    ]),
  ];
  const unique = new Map<string, StorageObjectRef>();
  for (const ref of refs) {
    if (ref.key === null || ref.key === undefined) continue;
    assertStorageKey(ref.key);
    const previous = unique.get(ref.key);
    if (previous && previous.tenantId !== ref.tenantId) {
      throw new Error('The same storage key is referenced by different tenants');
    }
    unique.set(ref.key, { key: ref.key, tenantId: ref.tenantId });
  }
  return [...unique.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export async function copyEncryptedStorageObjects(
  refs: StorageObjectRef[],
  source: FileStorage,
  destination: FileStorage | undefined,
  cipher: ClinicalCipher,
  execute: boolean,
): Promise<StorageCopySummary> {
  const unique = new Map<string, StorageObjectRef>();
  for (const ref of refs) {
    assertStorageKey(ref.key);
    const previous = unique.get(ref.key);
    if (previous && previous.tenantId !== ref.tenantId) {
      throw new Error('The same storage key is referenced by different tenants');
    }
    unique.set(ref.key, ref);
  }
  if (execute && !cipher.enabled) {
    throw new Error('CLINICAL_ENCRYPTION_KEYS is required to migrate clinical files');
  }

  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const files: {
    key: string;
    tenantId: string;
    size: number;
    plaintext: boolean;
    digest: string;
  }[] = [];
  let missing = 0;
  for (const { key, tenantId } of [...unique.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    let bytes: Buffer;
    try {
      bytes = await source.get(key);
    } catch {
      missing++;
      continue;
    }
    const plaintext = bytes.subarray(0, 4).toString('ascii') !== 'ENC1';
    if (execute && !plaintext) cipher.decryptBuffer(tenantId, bytes);
    files.push({ key, tenantId, size: bytes.length, plaintext, digest: digest(bytes) });
  }
  if (missing)
    throw new Error(`${missing} referenced local storage objects are missing or unreadable`);

  const summary: StorageCopySummary = {
    planned: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    plaintextSource: files.filter((file) => file.plaintext).length,
    uploaded: 0,
    reused: 0,
    verified: 0,
  };
  if (!execute) return summary;
  if (!destination) throw new Error('Supabase destination is required for --execute');
  // Preflight above checks every source and decryption key before any remote write.
  // Read again per object so file contents do not accumulate in memory.

  for (const { key, tenantId, plaintext, digest: originalDigest } of files) {
    let bytes: Buffer;
    try {
      bytes = await source.get(key);
    } catch {
      throw new Error('Local storage object became unreadable during migration');
    }
    if (digest(bytes) !== originalDigest) {
      throw new Error('Local storage object changed during migration');
    }
    const plain = plaintext ? bytes : cipher.decryptBuffer(tenantId, bytes);
    const encrypted = plaintext ? cipher.encryptBuffer(tenantId, plain) : bytes;
    try {
      await destination.put(key, encrypted);
      summary.uploaded++;
    } catch (writeError) {
      let existing: Buffer;
      try {
        existing = await destination.get(key);
      } catch {
        throw new Error('Supabase upload failed and the object cannot be read', {
          cause: writeError,
        });
      }
      if (
        existing.subarray(0, 4).toString('ascii') !== 'ENC1' ||
        !cipher.decryptBuffer(tenantId, existing).equals(plain)
      ) {
        throw new Error('Existing storage object differs from source');
      }
      summary.reused++;
    }
    const stored = await destination.get(key);
    if (
      stored.subarray(0, 4).toString('ascii') !== 'ENC1' ||
      !cipher.decryptBuffer(tenantId, stored).equals(plain)
    ) {
      throw new Error('Stored object verification failed');
    }
    summary.verified++;
  }
  return summary;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const execute = args.length === 1 && args[0] === '--execute';
  const sourceDirectory = process.env.STORAGE_MIGRATION_SOURCE_DIR;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  const prisma = new PrismaClient();

  (async () => {
    if (args.length && !execute) throw new Error('Use --execute or no arguments for a dry run');
    if (!sourceDirectory || !path.isAbsolute(sourceDirectory)) {
      throw new Error('STORAGE_MIGRATION_SOURCE_DIR must be an absolute path');
    }
    if (!bucket) throw new Error('SUPABASE_STORAGE_BUCKET is required');
    const rows = await prisma.$queryRawUnsafe<{ public: boolean }[]>(
      'SELECT public FROM storage.buckets WHERE id = $1',
      bucket,
    );
    if (rows.length !== 1 || rows[0].public) {
      throw new Error('The destination bucket must exist in this database project and be private');
    }
    if (execute) {
      const databaseUrl = process.env.DATABASE_URL;
      const supabaseUrl = process.env.SUPABASE_URL;
      if (!databaseUrl || !supabaseUrl)
        throw new Error('DATABASE_URL and SUPABASE_URL are required');
      assertSupabaseProjectUrl(databaseUrl, supabaseUrl);
    }

    const keys = await collectReferencedStorageKeys(prisma);
    const source = new LocalFileStorage(new ConfigService({ STORAGE_LOCAL_PATH: sourceDirectory }));
    const destination = execute
      ? new SupabaseFileStorage(new ConfigService(process.env))
      : undefined;
    const cipher = new ClinicalCipher(parseClinicalKeys(process.env.CLINICAL_ENCRYPTION_KEYS));
    const summary = await copyEncryptedStorageObjects(keys, source, destination, cipher, execute);
    console.log(JSON.stringify({ mode: execute ? 'execute' : 'dry-run', ...summary }));
  })()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
