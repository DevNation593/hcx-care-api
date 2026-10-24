import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher, parseClinicalKeys } from '../clinical-access/clinical-cipher';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_PLANS } from '../plans/default-plans';
import { FileStorage, LocalFileStorage } from './file-storage';
import { PatientFilesService, UploadedFilePart } from './patient-files.service';

const key = (id: string) => `${id}:${randomBytes(32).toString('base64')}`;
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('Hemograma: hemoglobina 13,5 g/dL'),
]);

describe('ClinicalCipher for files', () => {
  const oldKey = key('2025');
  const cipher = new ClinicalCipher(parseClinicalKeys(oldKey));

  it('stores neither the bytes nor a repeatable ciphertext, and reads them back', () => {
    const first = cipher.encryptBuffer('tenant-1', PDF);
    const second = cipher.encryptBuffer('tenant-1', PDF);

    expect(first.subarray(0, 4).toString('ascii')).toBe('ENC1');
    expect(first.includes(Buffer.from('hemoglobina'))).toBe(false);
    expect(first.equals(second)).toBe(false);
    expect(cipher.decryptBuffer('tenant-1', first).equals(PDF)).toBe(true);
  });

  it('does not decrypt a file moved to another tenant or tampered with', () => {
    const stored = cipher.encryptBuffer('tenant-1', PDF);
    const tampered = Buffer.from(stored);
    tampered[tampered.length - 1] ^= 1;

    expect(() => cipher.decryptBuffer('tenant-2', stored)).toThrow();
    expect(() => cipher.decryptBuffer('tenant-1', tampered)).toThrow();
  });

  it('keeps reading files written with a retired key and refuses an unknown one', () => {
    const stored = cipher.encryptBuffer('tenant-1', PDF);
    const rotated = new ClinicalCipher(parseClinicalKeys(`${key('2026')},${oldKey}`));

    expect(rotated.decryptBuffer('tenant-1', stored).equals(PDF)).toBe(true);
    expect(() =>
      new ClinicalCipher(parseClinicalKeys(key('2026'))).decryptBuffer('tenant-1', stored),
    ).toThrow(/unknown key "2025"/);
  });

  it('passes bytes through when no key is configured', () => {
    const plain = new ClinicalCipher();

    expect(plain.encryptBuffer('tenant-1', PDF)).toBe(PDF);
    expect(plain.decryptBuffer('tenant-1', PDF)).toBe(PDF);
  });
});

describe('LocalFileStorage', () => {
  let root: string;
  let storage: LocalFileStorage;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'patient-files-'));
    storage = new LocalFileStorage({ get: () => root } as unknown as ConfigService);
  });
  afterAll(() => fs.rm(root, { recursive: true, force: true }));

  it('writes, reads and removes a file under its key', async () => {
    await storage.put('tenant-1/patient-1/file-a', PDF);

    expect((await storage.get('tenant-1/patient-1/file-a')).equals(PDF)).toBe(true);
    expect(await fs.readdir(path.join(root, 'tenant-1', 'patient-1'))).toEqual(['file-a']);

    await storage.remove('tenant-1/patient-1/file-a');
    await expect(storage.get('tenant-1/patient-1/file-a')).rejects.toThrow();
    // Removing what is already gone is not an error.
    await expect(storage.remove('tenant-1/patient-1/file-a')).resolves.toBeUndefined();
  });

  it('never overwrites an existing key', async () => {
    await storage.put('tenant-1/patient-1/file-b', PDF);

    await expect(storage.put('tenant-1/patient-1/file-b', Buffer.from('other'))).rejects.toThrow();
    expect((await storage.get('tenant-1/patient-1/file-b')).equals(PDF)).toBe(true);
  });

  it.each(['../outside', 'tenant-1/../../etc/passwd', '/etc/passwd', 'a\\b', 'a//b', '', 'a/.'])(
    'refuses the key %p',
    async (bad) => {
      await expect(storage.put(bad, PDF)).rejects.toThrow('Invalid storage key');
      await expect(storage.get(bad)).rejects.toThrow('Invalid storage key');
    },
  );
});

describe('PatientFilesService', () => {
  const cipher = new ClinicalCipher(parseClinicalKeys(key('2026')));
  const dentist: ClinicalActor = {
    userId: 'dentist',
    role: 'PROFESIONAL',
    specialtyId: 'dentistry',
  };
  const other: ClinicalActor = { ...dentist, userId: 'other' };
  const blobs = new Map<string, Buffer>();
  const storage: FileStorage & { removed: string[] } = {
    removed: [],
    put: async (storageKey, data) => void blobs.set(storageKey, data),
    get: async (storageKey) => blobs.get(storageKey)!,
    remove: async (storageKey) => {
      storage.removed.push(storageKey);
      blobs.delete(storageKey);
    },
  };
  const db = {
    patient: { findFirst: jest.fn() },
    encounter: { findFirst: jest.fn() },
    professionalProfile: { findFirst: jest.fn() },
    tenantSubscription: { findUnique: jest.fn(), updateMany: jest.fn() },
    patientFile: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
    auditLog: { createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const service = new PatientFilesService(
    prisma as unknown as PrismaService,
    new ClinicalAuditService(prisma as unknown as PrismaService, cipher),
    cipher,
    storage,
  );
  const part = (overrides: Partial<UploadedFilePart> = {}): UploadedFilePart => ({
    // As multer hands it over: the UTF-8 name read as latin1.
    originalname: Buffer.from('exámenes/hemograma José.pdf', 'utf8').toString('latin1'),
    mimetype: 'application/pdf',
    size: PDF.length,
    buffer: PDF,
    ...overrides,
  });
  const upload = (file: UploadedFilePart | undefined = part(), dto = {}) =>
    service.upload('tenant-1', 'patient-1', dentist, file, { category: 'EXAMEN', ...dto } as never);
  const created = () => db.patientFile.create.mock.calls[0][0].data;
  const auditRows = () => db.auditLog.createMany.mock.calls.flatMap(([args]) => args.data);

  beforeEach(() => {
    jest.resetAllMocks();
    blobs.clear();
    storage.removed = [];
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.patient.findFirst.mockResolvedValue({ id: 'patient-1' });
    db.tenantSubscription.findUnique.mockResolvedValue({ storageGB: 1 });
    db.tenantSubscription.updateMany.mockResolvedValue({ count: 1 });
    db.patientFile.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'file-1', createdAt: new Date(), deletedAt: null, ...data }),
    );
  });

  describe('upload', () => {
    it('stores the bytes encrypted and the name encrypted, and returns them readable', async () => {
      const file = await upload(part(), { description: ' Control anual ' });

      const [[storageKey, stored]] = [...blobs];
      expect(storageKey).toMatch(/^tenant-1\/patient-1\/[0-9a-f-]{36}$/);
      expect(stored.includes(Buffer.from('hemoglobina'))).toBe(false);
      expect(cipher.decryptBuffer('tenant-1', stored).equals(PDF)).toBe(true);

      expect(created()).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        uploadedById: 'dentist',
        category: 'EXAMEN',
        mimeType: 'application/pdf',
        sizeBytes: PDF.length,
        storageKey,
      });
      expect(created().fileName).toMatch(/^enc:v1:/);
      expect(created().description).toMatch(/^enc:v1:/);
      // The path sent by the browser is dropped and the accents survive.
      expect(file).toMatchObject({ fileName: 'hemograma José.pdf', description: 'Control anual' });
      expect(file).not.toHaveProperty('storageKey');
    });

    it('counts the file against the plan under the account context and audits it', async () => {
      await upload();

      expect(db.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-1',
          storageUsedBytes: { lte: BigInt(1024 ** 3 - PDF.length) },
        },
        data: { storageUsedBytes: { increment: BigInt(PDF.length) } },
      });
      expect(prisma.applyRlsContext.mock.calls.map(([, context]) => context?.role)).toEqual([
        undefined,
        'MASTER',
        'PROFESIONAL',
      ]);
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          entity: 'PATIENT_FILE',
          entityId: 'file-1',
          patientId: 'patient-1',
          userId: 'dentist',
        }),
      ]);
    });

    it('refuses the file when the plan has no room left, and leaves no bytes behind', async () => {
      db.tenantSubscription.updateMany.mockResolvedValue({ count: 0 });

      await expect(upload()).rejects.toMatchObject({
        status: 413,
        response: { code: 'STORAGE_LIMIT_REACHED' },
      });
      expect(db.patientFile.create).not.toHaveBeenCalled();
      expect(blobs.size).toBe(0);
      expect(storage.removed).toHaveLength(1);
    });

    describe('against the quota of the smallest plan', () => {
      const smallest = Math.min(...DEFAULT_PLANS.map((plan) => plan.storageGB));
      const quotaBytes = smallest * 1024 ** 3;
      // Plays the database: the counter moves only while the usage satisfies the where clause.
      const alreadyUsed = (bytes: number) =>
        db.tenantSubscription.updateMany.mockImplementation(({ where }) =>
          Promise.resolve({ count: BigInt(bytes) <= where.storageUsedBytes.lte ? 1 : 0 }),
        );

      beforeEach(() => {
        db.tenantSubscription.findUnique.mockResolvedValue({
          storageGB: smallest,
        });
      });

      it('accepts a file that fills the quota exactly', async () => {
        alreadyUsed(quotaBytes - PDF.length);

        await upload();

        expect(db.patientFile.create).toHaveBeenCalled();
      });

      it('refuses a file that would go over the quota', async () => {
        alreadyUsed(quotaBytes - PDF.length + 1);

        await expect(upload()).rejects.toMatchObject({
          status: 413,
          response: { code: 'STORAGE_LIMIT_REACHED' },
        });
        expect(db.patientFile.create).not.toHaveBeenCalled();
      });

      it('no longer reads storageGB 0 as unlimited', async () => {
        db.tenantSubscription.findUnique.mockResolvedValue({ storageGB: 0 });
        alreadyUsed(0);

        await expect(upload()).rejects.toMatchObject({ status: 413 });
        expect(db.patientFile.create).not.toHaveBeenCalled();
      });
    });

    it('links a photo to the treatment session and phase it was taken in', async () => {
      await service.upload(
        'tenant-1',
        'patient-1',
        dentist,
        part({ mimetype: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]) }),
        { category: 'IMAGEN' },
        { treatmentSessionId: 'session-1', phase: 'BEFORE' },
      );

      expect(created()).toMatchObject({
        category: 'IMAGEN',
        treatmentSessionId: 'session-1',
        phase: 'BEFORE',
      });
    });

    it('leaves a file outside any treatment session without session or phase', async () => {
      await upload();

      expect(created().treatmentSessionId).toBeUndefined();
      expect(created().phase).toBeUndefined();
    });

    it('rejects a request without a file', async () => {
      await expect(
        service.upload('tenant-1', 'patient-1', dentist, undefined, { category: 'EXAMEN' }),
      ).rejects.toMatchObject({ status: 400, response: { code: 'PATIENT_FILE_INVALID' } });
    });

    it.each([
      ['an empty file', part({ buffer: Buffer.alloc(0) })],
      ['a type that is not accepted', part({ mimetype: 'application/zip' })],
      ['a file whose bytes are not what it claims', part({ buffer: Buffer.from('<html>') })],
      ['an image declared as PDF', part({ buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]) })],
    ])('rejects %s', async (_label, file) => {
      await expect(upload(file)).rejects.toMatchObject({
        status: 400,
        response: { code: 'PATIENT_FILE_INVALID' },
      });
      expect(blobs.size).toBe(0);
    });

    it('accepts JPG and PNG by their own signatures', async () => {
      await upload(
        part({ mimetype: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]) }),
      );
      await upload(part({ mimetype: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) }));

      expect(db.patientFile.create).toHaveBeenCalledTimes(2);
    });

    it('rejects a file over 10 MB', async () => {
      const big = Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(10 * 1024 * 1024)]);

      await expect(upload(part({ buffer: big }))).rejects.toMatchObject({
        status: 413,
        response: { code: 'PATIENT_FILE_TOO_LARGE' },
      });
    });

    it('does not upload to a patient outside the tenant or into a foreign encounter', async () => {
      db.patient.findFirst.mockResolvedValueOnce(null);
      await expect(upload()).rejects.toMatchObject({ status: 404 });

      db.encounter.findFirst.mockResolvedValue({ professionalId: 'someone', status: 'OPEN' });
      await expect(upload(part(), { encounterId: 'encounter-1' })).rejects.toMatchObject({
        status: 403,
      });
      expect(blobs.size).toBe(0);
    });
  });

  describe('reading', () => {
    const stored = (overrides = {}) => ({
      id: 'file-1',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      uploadedById: 'dentist',
      fileName: cipher.encrypt('tenant-1', 'hemograma.pdf'),
      description: null,
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
      storageKey: 'tenant-1/patient-1/blob',
      createdAt: new Date('2026-10-03T10:00:00Z'),
      uploadedBy: { id: 'dentist', firstName: 'Carlos', lastName: 'Vera' },
      patient: { id: 'patient-1', firstName: 'Lucía', lastName: 'Torres' },
      ...overrides,
    });

    it('lists the live files of the patient and audits each one', async () => {
      db.patientFile.findMany.mockResolvedValue([stored()]);

      const [file] = await service.list('tenant-1', 'patient-1', other);

      expect(db.patientFile.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
      expect(file.fileName).toBe('hemograma.pdf');
      expect(file).not.toHaveProperty('storageKey');
      expect(auditRows()).toEqual([
        expect.objectContaining({ action: 'READ', entity: 'PATIENT_FILE', userId: 'other' }),
      ]);
    });

    it('downloads the decrypted bytes and audits the read', async () => {
      blobs.set('tenant-1/patient-1/blob', cipher.encryptBuffer('tenant-1', PDF));
      db.patientFile.findFirst.mockResolvedValue(stored());

      const file = await service.download('tenant-1', 'patient-1', 'file-1', other);

      expect(db.patientFile.findFirst.mock.calls[0][0].where).toEqual({
        id: 'file-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
      expect(file).toEqual({ fileName: 'hemograma.pdf', mimeType: 'application/pdf', data: PDF });
      expect(auditRows()).toEqual([
        expect.objectContaining({ action: 'READ', entityId: 'file-1', userId: 'other' }),
      ]);
    });

    it('does not download a removed file or one of another patient', async () => {
      db.patientFile.findFirst.mockResolvedValue(null);

      await expect(
        service.download('tenant-1', 'patient-1', 'gone', dentist),
      ).rejects.toMatchObject({ status: 404, response: { code: 'CLINICAL_RECORD_NOT_FOUND' } });
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });

    it('masks file names in the storage page for an account without a professional profile', async () => {
      db.patientFile.findMany.mockResolvedValue([stored()]);

      db.professionalProfile.findFirst.mockResolvedValueOnce(null);
      const [masked] = await service.listForAccount('tenant-1', 'master');
      expect(masked).toMatchObject({
        fileName: 'Archivo clínico',
        fileSize: PDF.length,
        category: 'attachment',
        relatedTo: { type: 'patient', id: 'patient-1', name: 'Lucía Torres' },
        uploadedBy: 'Carlos Vera',
        url: '',
      });

      db.professionalProfile.findFirst.mockResolvedValueOnce({ userId: 'dentist' });
      const [clear] = await service.listForAccount('tenant-1', 'dentist');
      expect(clear.fileName).toBe('hemograma.pdf');
    });

    it('reports the space used, removed files included', async () => {
      db.patientFile.aggregate.mockResolvedValue({ _sum: { sizeBytes: 4096 } });

      expect(await service.usage('tenant-1')).toEqual({
        total: 4096,
        attachments: 4096,
        avatars: 0,
        exports: 0,
      });
      expect(db.patientFile.aggregate.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1' });
    });
  });

  describe('delete', () => {
    const row = {
      id: 'file-1',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      uploadedById: 'dentist',
      fileName: 'hemograma.pdf',
      description: null,
      storageKey: 'tenant-1/patient-1/blob',
    };

    it('keeps the row and the bytes, and records who removed it and why', async () => {
      blobs.set(row.storageKey, PDF);
      db.patientFile.findFirst.mockResolvedValue(row);

      await service.delete('tenant-1', 'patient-1', 'file-1', dentist, {
        reason: 'Paciente equivocado',
      });

      const { data } = db.patientFile.update.mock.calls[0][0];
      expect(data).toMatchObject({ deletedAt: expect.any(Date), deletedById: 'dentist' });
      expect(cipher.decrypt('tenant-1', data.deletionReason)).toBe('Paciente equivocado');
      expect(blobs.has(row.storageKey)).toBe(true);
      expect(auditRows()).toEqual([
        expect.objectContaining({ action: 'DELETE', entity: 'PATIENT_FILE', entityId: 'file-1' }),
      ]);
    });

    it('lets only the uploader remove a file', async () => {
      db.patientFile.findFirst.mockResolvedValue(row);

      await expect(
        service.delete('tenant-1', 'patient-1', 'file-1', other, { reason: 'x' }),
      ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });
      expect(db.patientFile.update).not.toHaveBeenCalled();
    });
  });
});
