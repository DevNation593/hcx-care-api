import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { ConsentTemplatesService } from '../consents/consent-templates.service';
import { EncountersService } from '../encounters/encounters.service';
import { FileStorage } from '../patient-files/file-storage';
import { PatientFilesService, UploadedFilePart } from '../patient-files/patient-files.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpecialtyRecordsService } from '../specialty-records/specialty-records.service';
import { TreatmentRequirements } from '../treatments/treatment-requirements';
import { TreatmentsService } from '../treatments/treatments.service';
import { SessionMediaService } from './session-media.service';
import { TreatmentSessionsService } from './treatment-sessions.service';

/** Builds a marker segment: FF xx, big-endian length (counting its own 2 bytes), payload. */
const segment = (marker: number, payload: Buffer) =>
  Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const APP0 = segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'));
const EXIF = segment(0xe1, Buffer.from('Exif\0\0GPS -0.18,-78.47 iPhone'));
const SOS = segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
const SCAN = Buffer.from([0x12, 0x34, 0x56]);
const JPEG_WITH_EXIF = Buffer.concat([SOI, APP0, EXIF, SOS, SCAN, EOI]);
const JPEG_CLEAN = Buffer.concat([SOI, APP0, SOS, SCAN, EOI]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.7\nInforme');

describe('SessionMediaService', () => {
  const plain = new ClinicalCipher();
  const professional: ClinicalActor = {
    userId: 'pro',
    role: 'PROFESIONAL',
    specialtyId: 'aesthetics',
  };
  const policy: TreatmentRequirements = {
    medicalForm: { required: false },
    informedConsent: { required: true, validityDays: null },
    photos: { minimumBefore: 1, minimumAfter: 1 },
    clinicalNotes: { requiredForCompletion: false },
  };
  const loaded = (overrides = {}) => ({
    id: 'session-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    professionalId: 'pro',
    branchId: null,
    appointmentId: null,
    treatmentVersionId: 'version-1',
    encounterId: 'encounter-1',
    formRecordId: null,
    consentDocumentId: null,
    status: 'CONSENTED',
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    procedureNotes: null,
    cancellationReason: null,
    version: 1,
    createdAt: new Date('2026-10-15T14:00:00Z'),
    updatedAt: new Date('2026-10-15T14:00:00Z'),
    treatmentVersion: {
      id: 'version-1',
      tenantId: 'tenant-1',
      treatmentId: 'treatment-1',
      version: 1,
      formDefinitionId: null,
      formVersion: null,
      consentTemplateVersionId: 'consent-v1',
      requirements: policy,
      treatment: { id: 'treatment-1', tenantId: 'tenant-1', name: 'Toxina botulínica' },
    },
    ...overrides,
  });

  const blobs = new Map<string, Buffer>();
  const storage: FileStorage = {
    put: async (key, data) => void blobs.set(key, data),
    get: async (key) => blobs.get(key)!,
    remove: async (key) => void blobs.delete(key),
  };
  const db = {
    patient: { findFirst: jest.fn() },
    encounter: { findFirst: jest.fn() },
    tenantSubscription: { findUnique: jest.fn(), updateMany: jest.fn() },
    treatmentSession: { findFirst: jest.fn() },
    patientFile: { create: jest.fn() },
    auditLog: { createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const prismaService = prisma as unknown as PrismaService;
  const audit = new ClinicalAuditService(prismaService, plain);
  const sessions = new TreatmentSessionsService(
    prismaService,
    audit,
    plain,
    new TreatmentsService(prismaService, new ConsentTemplatesService(prismaService)),
    new EncountersService(prismaService, audit, plain),
    new SpecialtyRecordsService(prismaService, audit, plain),
  );
  const service = new SessionMediaService(
    prismaService,
    sessions,
    new PatientFilesService(prismaService, audit, plain, storage),
  );

  const part = (overrides: Partial<UploadedFilePart> = {}): UploadedFilePart => ({
    originalname: 'antes.jpg',
    mimetype: 'image/jpeg',
    size: JPEG_WITH_EXIF.length,
    buffer: JPEG_WITH_EXIF,
    ...overrides,
  });
  const upload = (file: UploadedFilePart, phase: 'BEFORE' | 'AFTER' | 'OTHER' = 'BEFORE') =>
    service.upload('tenant-1', 'session-1', professional, file, { phase });
  const created = () => db.patientFile.create.mock.calls[0][0].data;

  beforeEach(() => {
    jest.resetAllMocks();
    blobs.clear();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.treatmentSession.findFirst.mockResolvedValue(loaded());
    db.patient.findFirst.mockResolvedValue({ id: 'patient-1' });
    db.encounter.findFirst.mockResolvedValue({
      id: 'encounter-1',
      patientId: 'patient-1',
      professionalId: 'pro',
      status: 'OPEN',
    });
    db.tenantSubscription.findUnique.mockResolvedValue({ storageGB: 0 });
    db.tenantSubscription.updateMany.mockResolvedValue({ count: 1 });
    db.patientFile.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'file-1', createdAt: new Date(), deletedAt: null, ...data }),
    );
  });

  it('refuses a BEFORE photo while the intake is in progress', async () => {
    db.treatmentSession.findFirst.mockResolvedValue(loaded({ status: 'INTAKE_IN_PROGRESS' }));

    await expect(upload(part())).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'SESSION_PHOTO_PHASE_NOT_ALLOWED',
        status: 'INTAKE_IN_PROGRESS',
        phase: 'BEFORE',
      },
    });
    expect(blobs.size).toBe(0);
    expect(db.patientFile.create).not.toHaveBeenCalled();
  });

  it('stores a BEFORE photo of a consented session without its APP1 bytes', async () => {
    const file = await upload(part());

    const [stored] = [...blobs.values()];
    expect(stored.equals(JPEG_CLEAN)).toBe(true);
    expect(stored.includes(Buffer.from('Exif'))).toBe(false);
    expect(created()).toMatchObject({
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      uploadedById: 'pro',
      encounterId: 'encounter-1',
      category: 'IMAGEN',
      mimeType: 'image/jpeg',
      sizeBytes: JPEG_CLEAN.length,
      treatmentSessionId: 'session-1',
      phase: 'BEFORE',
    });
    expect(file).toMatchObject({ id: 'file-1', phase: 'BEFORE', treatmentSessionId: 'session-1' });
    expect(file).not.toHaveProperty('storageKey');
    // The upload itself is audited once, as a patient file.
    expect(db.auditLog.createMany.mock.calls.flatMap(([args]) => args.data)).toEqual([
      expect.objectContaining({ action: 'CREATE', entity: 'PATIENT_FILE', entityId: 'file-1' }),
    ]);
    const [{ changes }] = db.auditLog.createMany.mock.calls[0][0].data;
    expect(plain.decryptJson('tenant-1', changes)).toMatchObject({
      before: null,
      after: { treatmentSessionId: 'session-1', phase: 'BEFORE', category: 'IMAGEN' },
    });
  });

  it('refuses an AFTER photo before the procedure has started', async () => {
    await expect(upload(part(), 'AFTER')).rejects.toMatchObject({
      status: 409,
      response: { code: 'SESSION_PHOTO_PHASE_NOT_ALLOWED', status: 'CONSENTED', phase: 'AFTER' },
    });
    expect(blobs.size).toBe(0);
  });

  it('accepts an AFTER photo once the procedure is in progress', async () => {
    db.treatmentSession.findFirst.mockResolvedValue(
      loaded({ status: 'IN_PROGRESS', startedAt: new Date() }),
    );

    await upload(part({ mimetype: 'image/png', buffer: PNG }), 'AFTER');

    expect(created()).toMatchObject({ phase: 'AFTER', mimeType: 'image/png' });
    expect([...blobs.values()][0].equals(PNG)).toBe(true);
  });

  it('refuses anyone but the professional of the session', async () => {
    db.treatmentSession.findFirst.mockResolvedValue(loaded({ professionalId: 'other' }));

    await expect(upload(part())).rejects.toMatchObject({
      status: 403,
      response: { code: 'CLINICAL_RECORD_FORBIDDEN' },
    });
    expect(blobs.size).toBe(0);
  });

  it('rejects a PDF as a BEFORE photo', async () => {
    await expect(
      upload(part({ originalname: 'informe.pdf', mimetype: 'application/pdf', buffer: PDF })),
    ).rejects.toMatchObject({ status: 400, response: { code: 'PATIENT_FILE_INVALID' } });
    expect(blobs.size).toBe(0);
  });

  it('takes a PDF as a file of the session in the OTHER phase', async () => {
    await upload(
      part({ originalname: 'informe.pdf', mimetype: 'application/pdf', buffer: PDF }),
      'OTHER',
    );

    expect(created()).toMatchObject({ phase: 'OTHER', mimeType: 'application/pdf' });
  });

  it('rejects PNG bytes declared as JPEG and stores nothing', async () => {
    await expect(upload(part({ buffer: PNG }))).rejects.toMatchObject({
      status: 400,
      response: { code: 'PATIENT_FILE_INVALID' },
    });
    expect(blobs.size).toBe(0);
    expect(db.patientFile.create).not.toHaveBeenCalled();
  });

  it('rejects a truncated JPEG', async () => {
    const truncated = Buffer.concat([SOI, APP0, EXIF.subarray(0, 8)]);

    await expect(upload(part({ buffer: truncated }))).rejects.toMatchObject({
      status: 400,
      response: { code: 'PATIENT_FILE_INVALID' },
    });
    expect(blobs.size).toBe(0);
    expect(db.patientFile.create).not.toHaveBeenCalled();
  });

  it('does not find a session of another tenant', async () => {
    db.treatmentSession.findFirst.mockResolvedValue(null);

    await expect(upload(part())).rejects.toMatchObject({
      status: 404,
      response: { code: 'TREATMENT_SESSION_NOT_FOUND' },
    });
    expect(db.treatmentSession.findFirst.mock.calls[0][0].where).toEqual({
      id: 'session-1',
      tenantId: 'tenant-1',
    });
  });
});
