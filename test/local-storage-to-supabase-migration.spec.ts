import {
  assertSupabaseProjectUrl,
  collectReferencedStorageKeys,
  copyEncryptedStorageObjects,
} from '../prisma/migrate-local-storage-to-supabase';
import { ClinicalCipher, parseClinicalKeys } from '../src/clinical-access/clinical-cipher';
import { FileStorage } from '../src/patient-files/file-storage';

const CIPHER = new ClinicalCipher(
  parseClinicalKeys(`2026:${Buffer.alloc(32, 7).toString('base64')}`),
);
const ref = (key: string) => ({ key, tenantId: 'tenant-a' });

class MemoryStorage implements FileStorage {
  readonly objects = new Map<string, Buffer>();
  writes = 0;

  async put(key: string, data: Buffer): Promise<void> {
    this.writes++;
    if (this.objects.has(key)) throw new Error('The resource already exists');
    this.objects.set(key, Buffer.from(data));
  }

  async get(key: string): Promise<Buffer> {
    const data = this.objects.get(key);
    if (!data) throw new Error('Object not found');
    return Buffer.from(data);
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

describe('local clinical file migration', () => {
  it('accepts the project API and direct Storage hosts, but no other project', () => {
    const databaseUrl =
      'postgresql://postgres.project123:pass@aws-1.pooler.supabase.com:5432/postgres';
    expect(() =>
      assertSupabaseProjectUrl(databaseUrl, 'https://project123.supabase.co'),
    ).not.toThrow();
    expect(() =>
      assertSupabaseProjectUrl(databaseUrl, 'https://project123.storage.supabase.co'),
    ).not.toThrow();
    expect(() =>
      assertSupabaseProjectUrl(databaseUrl, 'https://other.storage.supabase.co'),
    ).toThrow('SUPABASE_URL does not match the database project');
    expect(() => assertSupabaseProjectUrl(databaseUrl, 'http://project123.supabase.co')).toThrow(
      'SUPABASE_URL must use HTTPS',
    );
  });

  it('collects every referenced object, including a soft-deleted patient file', async () => {
    const database = {
      patientFile: {
        findMany: async () => [
          { tenantId: 'tenant-a', storageKey: 'patients/old' },
          { tenantId: 'tenant-a', storageKey: 'patients/live' },
        ],
      },
      consentDocument: {
        findMany: async () => [{ tenantId: 'tenant-a', pdfStorageKey: 'consents/pdf' }],
      },
      consentSignature: {
        findMany: async () => [{ tenantId: 'tenant-a', signatureStorageKey: 'consents/signature' }],
      },
      invoiceRequest: {
        findMany: async () => [
          { tenantId: 'tenant-a', xmlStorageKey: 'invoices/xml', rideStorageKey: 'invoices/ride' },
          { tenantId: 'tenant-a', xmlStorageKey: 'invoices/xml', rideStorageKey: null },
        ],
      },
    };

    await expect(collectReferencedStorageKeys(database as never)).resolves.toEqual([
      ref('consents/pdf'),
      ref('consents/signature'),
      ref('invoices/ride'),
      ref('invoices/xml'),
      ref('patients/live'),
      ref('patients/old'),
    ]);
  });

  it('rejects an empty non-null database storage key', async () => {
    const database = {
      patientFile: { findMany: async () => [{ tenantId: 'tenant-a', storageKey: '' }] },
      consentDocument: { findMany: async () => [] },
      consentSignature: { findMany: async () => [] },
      invoiceRequest: { findMany: async () => [] },
    };
    await expect(collectReferencedStorageKeys(database as never)).rejects.toThrow(
      'Invalid storage key',
    );
  });

  it('checks every local object before writing anything to Supabase', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.objects.set('patients/first', Buffer.from([0, 255, 42]));

    await expect(
      copyEncryptedStorageObjects(
        [ref('patients/first'), ref('patients/missing')],
        source,
        destination,
        CIPHER,
        true,
      ),
    ).rejects.toThrow();
    expect(destination.writes).toBe(0);
  });

  it('refuses a local file changed after preflight before uploading it', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.objects.set('patients/first', Buffer.from([1, 2, 3]));
    const get = source.get.bind(source);
    let reads = 0;
    source.get = async (key) => {
      const bytes = await get(key);
      if (++reads === 1) source.objects.set(key, Buffer.from([4, 5, 6]));
      return bytes;
    };

    await expect(
      copyEncryptedStorageObjects([ref('patients/first')], source, destination, CIPHER, true),
    ).rejects.toThrow('changed during migration');
    expect(destination.writes).toBe(0);
  });

  it('rejects a storage key shared by different tenants before reading files', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.objects.set('patients/shared', Buffer.from([1]));

    await expect(
      copyEncryptedStorageObjects(
        [ref('patients/shared'), { key: 'patients/shared', tenantId: 'tenant-b' }],
        source,
        destination,
        CIPHER,
        true,
      ),
    ).rejects.toThrow('different tenants');
    expect(destination.writes).toBe(0);
  });

  it('encrypts legacy plaintext, verifies downloads, and resumes without overwriting', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    const first = Buffer.from([0, 255, 42]);
    const second = Buffer.from([128, 1, 0]);
    source.objects.set('patients/first', first);
    source.objects.set('patients/second', second);
    destination.objects.set('patients/first', CIPHER.encryptBuffer('tenant-a', first));

    await expect(
      copyEncryptedStorageObjects(
        [ref('patients/second'), ref('patients/first'), ref('patients/first')],
        source,
        destination,
        CIPHER,
        false,
      ),
    ).resolves.toEqual({
      planned: 2,
      bytes: 6,
      plaintextSource: 2,
      uploaded: 0,
      reused: 0,
      verified: 0,
    });
    expect(destination.writes).toBe(0);

    await expect(
      copyEncryptedStorageObjects(
        [ref('patients/second'), ref('patients/first'), ref('patients/first')],
        source,
        destination,
        CIPHER,
        true,
      ),
    ).resolves.toEqual({
      planned: 2,
      bytes: 6,
      plaintextSource: 2,
      uploaded: 1,
      reused: 1,
      verified: 2,
    });
    expect(destination.objects.get('patients/second')?.subarray(0, 4).toString()).toBe('ENC1');
    expect(CIPHER.decryptBuffer('tenant-a', destination.objects.get('patients/first')!)).toEqual(
      first,
    );
    expect(CIPHER.decryptBuffer('tenant-a', destination.objects.get('patients/second')!)).toEqual(
      second,
    );
    expect(source.objects.size).toBe(2);

    await expect(
      copyEncryptedStorageObjects(
        [ref('patients/first'), ref('patients/second')],
        source,
        destination,
        CIPHER,
        true,
      ),
    ).resolves.toEqual({
      planned: 2,
      bytes: 6,
      plaintextSource: 2,
      uploaded: 0,
      reused: 2,
      verified: 2,
    });
  });

  it('preserves an already encrypted source object byte for byte', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    const encrypted = CIPHER.encryptBuffer('tenant-a', Buffer.from('file'));
    source.objects.set('patients/encrypted', encrypted);

    await expect(
      copyEncryptedStorageObjects([ref('patients/encrypted')], source, destination, CIPHER, true),
    ).resolves.toEqual({
      planned: 1,
      bytes: encrypted.length,
      plaintextSource: 0,
      uploaded: 1,
      reused: 0,
      verified: 1,
    });
    expect(destination.objects.get('patients/encrypted')).toEqual(encrypted);
  });

  it('requires a clinical key before uploading plaintext', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.objects.set('patients/first', Buffer.from([1, 2, 3]));

    await expect(
      copyEncryptedStorageObjects(
        [ref('patients/first')],
        source,
        destination,
        new ClinicalCipher(),
        true,
      ),
    ).rejects.toThrow('CLINICAL_ENCRYPTION_KEYS');
    expect(destination.writes).toBe(0);
  });

  it('checks every encrypted local file with the configured key before uploading', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    const otherCipher = new ClinicalCipher(
      parseClinicalKeys(`other:${Buffer.alloc(32, 9).toString('base64')}`),
    );
    source.objects.set('patients/first', Buffer.from([1, 2, 3]));
    source.objects.set('patients/second', otherCipher.encryptBuffer('tenant-a', Buffer.from([4])));

    await expect(
      copyEncryptedStorageObjects(
        [ref('patients/first'), ref('patients/second')],
        source,
        destination,
        CIPHER,
        true,
      ),
    ).rejects.toThrow('unknown key');
    expect(destination.writes).toBe(0);
  });

  it('stops if an existing remote object differs from the local encrypted bytes', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    source.objects.set('patients/first', Buffer.from([1, 2, 3]));
    const existing = CIPHER.encryptBuffer('tenant-a', Buffer.from([4, 5, 6]));
    destination.objects.set('patients/first', existing);

    await expect(
      copyEncryptedStorageObjects([ref('patients/first')], source, destination, CIPHER, true),
    ).rejects.toThrow('Existing storage object differs from source');
    expect(destination.objects.get('patients/first')).toEqual(existing);
  });
});
