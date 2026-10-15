import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createHash, randomBytes } from 'crypto';
import { deflateSync } from 'zlib';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher, parseClinicalKeys } from '../clinical-access/clinical-cipher';
import { consentChecksum } from '../consents/consent-text';
import { ConsentTemplatesService } from '../consents/consent-templates.service';
import { EncountersService } from '../encounters/encounters.service';
import { FileStorage } from '../patient-files/file-storage';
import { PrismaService } from '../prisma/prisma.service';
import { SpecialtyRecordsService } from '../specialty-records/specialty-records.service';
import { TreatmentRequirements } from '../treatments/treatment-requirements';
import { TreatmentsService } from '../treatments/treatments.service';
import { ConsentDocumentsService } from './consent-documents.service';
import { SignConsentDto } from './dto/consent-document.dto';
import { TreatmentSessionsService } from './treatment-sessions.service';

/** A valid 1x1 RGB PNG built in memory. */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0x20, 0x20, 0x20]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('ConsentDocumentsService', () => {
  const cipher = new ClinicalCipher(
    parseClinicalKeys(`test:${randomBytes(32).toString('base64')}`),
  );
  const professional: ClinicalActor = {
    userId: 'pro',
    role: 'PROFESIONAL',
    specialtyId: 'aesthetics',
    ipAddress: '10.0.0.7',
    userAgent: 'Tablet/1.0',
  };
  const colleague: ClinicalActor = { ...professional, userId: 'other' };
  const master: ClinicalActor = { ...professional, userId: 'owner', role: 'MASTER' };
  const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const PNG = tinyPng();
  const SIGNATURE = `data:image/png;base64,${PNG.toString('base64')}`;

  const consentPolicy: TreatmentRequirements = {
    medicalForm: { required: false },
    informedConsent: { required: true, validityDays: null },
    photos: { minimumBefore: 0, minimumAfter: 0 },
    clinicalNotes: { requiredForCompletion: false },
  };
  const noConsentPolicy: TreatmentRequirements = {
    ...consentPolicy,
    informedConsent: { required: false, validityDays: null },
  };

  const session = (overrides = {}) => ({
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
    status: 'READY_FOR_CONSENT',
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    procedureNotes: null,
    cancellationReason: null,
    version: 3,
    createdAt: new Date('2026-10-15T14:00:00Z'),
    updatedAt: new Date('2026-10-15T14:00:00Z'),
    ...overrides,
  });
  const loaded = (requirements: TreatmentRequirements, overrides = {}) => ({
    ...session(overrides),
    treatmentVersion: {
      id: 'version-1',
      tenantId: 'tenant-1',
      treatmentId: 'treatment-1',
      version: 4,
      formDefinitionId: null,
      formVersion: null,
      consentTemplateVersionId: requirements.informedConsent.required ? 'consent-v2' : null,
      requirements,
      treatment: { id: 'treatment-1', tenantId: 'tenant-1', name: 'Toxina botulínica' },
    },
  });
  const templateVersion = (version: number, overrides = {}) => ({
    id: `consent-v${version}`,
    tenantId: 'tenant-1',
    templateId: 'template-1',
    version,
    title: 'Consentimiento para {{tratamiento}}',
    body: `v${version}: Yo, {{paciente}} ({{identificacion}}), autorizo a {{profesional}} el {{fecha}}.`,
    checksum: `checksum-v${version}`,
    status: 'PUBLISHED',
    ...overrides,
  });
  const adult = {
    firstName: 'Ana',
    lastName: 'Pérez',
    dateOfBirth: new Date('1990-05-01T00:00:00Z'),
    identificationNumber: '0102030405',
  };
  const document = (overrides: Record<string, unknown> = {}) => ({
    id: 'doc-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    treatmentSessionId: 'session-1',
    templateVersionId: 'consent-v2',
    title: cipher.encrypt('tenant-1', 'Consentimiento para Toxina botulínica'),
    body: cipher.encrypt('tenant-1', 'v2: Yo, Ana Pérez, autorizo.'),
    checksum: consentChecksum(
      'Consentimiento para Toxina botulínica',
      'v2: Yo, Ana Pérez, autorizo.',
    ),
    status: 'PRESENTED',
    presentedAt: new Date('2026-10-15T14:05:00Z'),
    signedAt: null,
    refusedAt: null,
    revokedAt: null,
    pdfStorageKey: null,
    pdfChecksum: null,
    createdAt: new Date('2026-10-15T14:05:00Z'),
    updatedAt: new Date('2026-10-15T14:05:00Z'),
    ...overrides,
  });

  const db = {
    patient: { findFirst: jest.fn() },
    user: { findFirst: jest.fn() },
    tenant: { findUnique: jest.fn() },
    appointment: { updateMany: jest.fn() },
    encounter: { findFirst: jest.fn(), update: jest.fn() },
    treatmentSession: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    consentTemplateVersion: { findFirst: jest.fn() },
    consentDocument: {
      findFirst: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    consentSignature: { create: jest.fn() },
    consentEvent: { create: jest.fn() },
    auditLog: { createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const prismaService = prisma as unknown as PrismaService;
  const audit = new ClinicalAuditService(prismaService, cipher);
  const encounters = new EncountersService(prismaService, audit, cipher);
  const sessions = new TreatmentSessionsService(
    prismaService,
    audit,
    cipher,
    new TreatmentsService(prismaService, new ConsentTemplatesService(prismaService)),
    encounters,
    new SpecialtyRecordsService(prismaService, audit, cipher),
  );
  const objects = new Map<string, Buffer>();
  const storage = {
    put: jest.fn(),
    get: jest.fn(),
    remove: jest.fn(),
  };
  const service = new ConsentDocumentsService(
    prismaService,
    audit,
    cipher,
    sessions,
    encounters,
    storage as unknown as FileStorage,
  );
  const auditRows = () => db.auditLog.createMany.mock.calls.flatMap(([args]) => args.data);
  const decryptedAudit = () =>
    JSON.stringify(
      auditRows().map((row: { changes: unknown }) => cipher.decryptJson('tenant-1', row.changes)),
    );

  beforeEach(() => {
    jest.resetAllMocks();
    objects.clear();
    storage.put.mockImplementation(async (key: string, data: Buffer) => {
      if (objects.has(key)) throw new Error('exists');
      objects.set(key, data);
    });
    storage.get.mockImplementation(async (key: string) => {
      const data = objects.get(key);
      if (!data) throw new Error('missing');
      return data;
    });
    storage.remove.mockImplementation(async (key: string) => {
      objects.delete(key);
    });
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.patient.findFirst.mockResolvedValue(adult);
    db.user.findFirst.mockResolvedValue({ firstName: 'Laura', lastName: 'Mora' });
    db.tenant.findUnique.mockResolvedValue({
      name: 'Clínica Bella',
      address: 'Av. Principal 123',
      settings: { timezone: 'America/Guayaquil' },
    });
    db.consentTemplateVersion.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === 'consent-v2'
          ? templateVersion(2, { status: 'RETIRED' })
          : templateVersion(3, { id: where.id }),
      ),
    );
    db.treatmentSession.findMany.mockResolvedValue([]);
    db.treatmentSession.update.mockImplementation(({ where, data }) =>
      Promise.resolve(
        session({
          id: where.id,
          status: data.status,
          consentDocumentId: data.consentDocument?.connect?.id ?? null,
          version: 4,
        }),
      ),
    );
    db.consentDocument.updateMany.mockResolvedValue({ count: 1 });
    db.consentSignature.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'signature-1', ...data }),
    );
    db.consentEvent.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'event-1', ...data }),
    );
    db.encounter.findFirst.mockResolvedValue({
      id: 'encounter-1',
      tenantId: 'tenant-1',
      patientId: 'patient-1',
      professionalId: 'pro',
      status: 'OPEN',
      appointmentId: null,
      treatmentSession: { id: 'session-1' },
    });
    db.encounter.update.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'encounter-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'pro',
        appointmentId: null,
        ...data,
      }),
    );
  });

  afterEach(() => jest.useRealTimers());

  describe('present', () => {
    beforeEach(() => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(consentPolicy));
      db.consentDocument.create.mockImplementation(({ data }) =>
        Promise.resolve(document({ ...data, id: 'doc-1' })),
      );
    });

    it('renders the pinned version, even retired, with the patient, treatment, professional and the clinic date', async () => {
      // 22:00 on the 14th in Guayaquil, already the 15th in UTC.
      jest.useFakeTimers({
        now: new Date('2026-10-15T03:00:00Z'),
        doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
      });
      db.consentDocument.findFirst.mockResolvedValue(null);

      const presented = await service.present('tenant-1', 'session-1', professional);

      expect(db.consentTemplateVersion.findFirst.mock.calls[0][0].where).toEqual({
        id: 'consent-v2',
        tenantId: 'tenant-1',
      });
      const title = 'Consentimiento para Toxina botulínica';
      const body =
        'v2: Yo, Ana Pérez (0102030405), autorizo a Laura Mora el 14 de octubre de 2026.';
      const data = db.consentDocument.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        treatmentSessionId: 'session-1',
        templateVersionId: 'consent-v2',
        checksum: consentChecksum(title, body),
      });
      expect(cipher.isEncrypted(data.title)).toBe(true);
      expect(cipher.isEncrypted(data.body)).toBe(true);
      expect(cipher.decrypt('tenant-1', data.body)).toBe(body);
      expect(presented).toMatchObject({ id: 'doc-1', title, body, status: 'PRESENTED' });
      expect(presented).not.toHaveProperty('pdfStorageKey');
      expect(db.consentEvent.create.mock.calls[0][0].data).toEqual({
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        type: 'PRESENTED',
        actorId: 'pro',
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          entity: 'CONSENT_DOCUMENT',
          entityId: 'doc-1',
          patientId: 'patient-1',
        }),
      ]);
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: 'Serializable' });
    });

    it('returns the document already presented instead of a second one', async () => {
      db.consentDocument.findFirst.mockResolvedValueOnce(null);
      const first = await service.present('tenant-1', 'session-1', professional);
      db.consentDocument.findFirst.mockResolvedValueOnce(document());

      const second = await service.present('tenant-1', 'session-1', professional);

      expect(second.id).toBe(first.id);
      expect(second.body).toBe('v2: Yo, Ana Pérez, autorizo.');
      expect(db.consentDocument.create).toHaveBeenCalledTimes(1);
      expect(db.consentDocument.findFirst.mock.calls[1][0].where).toEqual({
        tenantId: 'tenant-1',
        treatmentSessionId: 'session-1',
        status: 'PRESENTED',
      });
    });

    it('is refused on a treatment that requires no consent', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(noConsentPolicy));

      await expect(service.present('tenant-1', 'session-1', professional)).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONSENT_NOT_REQUIRED' },
      });
      expect(db.consentDocument.create).not.toHaveBeenCalled();
    });

    it('checks the professional before telling whether the treatment needs a consent', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(noConsentPolicy));

      await expect(service.present('tenant-1', 'session-1', colleague)).rejects.toMatchObject({
        status: 403,
        response: { code: 'CLINICAL_RECORD_FORBIDDEN' },
      });
    });

    it('is refused once the session no longer takes a consent', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(consentPolicy, { status: 'IN_PROGRESS' }),
      );

      await expect(service.present('tenant-1', 'session-1', professional)).rejects.toMatchObject({
        status: 409,
        response: { code: 'TREATMENT_SESSION_INVALID_TRANSITION' },
      });
    });

    it('is refused to anyone but the professional of the session', async () => {
      await expect(service.present('tenant-1', 'session-1', colleague)).rejects.toMatchObject({
        status: 403,
        response: { code: 'CLINICAL_RECORD_FORBIDDEN' },
      });
    });
  });

  describe('sign', () => {
    const dto = (overrides: Partial<SignConsentDto> = {}): SignConsentDto => ({
      signerRole: 'PATIENT',
      signerName: 'Ana Pérez',
      signerIdentification: '0102030405',
      understood: true,
      questionsAnswered: true,
      marketingPhotos: false,
      signature: SIGNATURE,
      ...overrides,
    });
    const sign = (body = dto(), actor = professional) =>
      service.sign('tenant-1', 'doc-1', actor, body);

    beforeEach(() => {
      db.consentDocument.findFirst.mockResolvedValue(document());
      db.treatmentSession.findFirst.mockResolvedValue(loaded(consentPolicy));
    });

    it('stores the signature and an encrypted PDF whose checksum it keeps, and consents the session', async () => {
      const before = Date.now();
      db.consentDocument.findFirst.mockResolvedValueOnce(document()).mockResolvedValueOnce(
        document({
          status: 'SIGNED',
          signedAt: new Date(),
          pdfChecksum: 'x',
          pdfStorageKey: 'k',
        }),
      );

      const signed = await sign();

      const claim = db.consentDocument.updateMany.mock.calls[0][0];
      expect(claim.where).toEqual({ id: 'doc-1', tenantId: 'tenant-1', status: 'PRESENTED' });
      expect(claim.data.status).toBe('SIGNED');
      expect(claim.data.signedAt.getTime()).toBeGreaterThanOrEqual(before);

      const pdfKey: string = claim.data.pdfStorageKey;
      expect(pdfKey.startsWith('tenant-1/consents/doc-1/pdf')).toBe(true);
      const storedPdf = objects.get(pdfKey)!;
      const pdf = cipher.decryptBuffer('tenant-1', storedPdf);
      expect(storedPdf.equals(pdf)).toBe(false);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(claim.data.pdfChecksum).toBe(sha256(pdf));

      const signature = db.consentSignature.create.mock.calls[0][0].data;
      expect(signature).toMatchObject({
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        signerRole: 'PATIENT',
        understood: true,
        questionsAnswered: true,
        marketingPhotos: false,
        operatorId: 'pro',
        ipAddress: '10.0.0.7',
        userAgent: 'Tablet/1.0',
      });
      expect(signature.signedAt).toEqual(claim.data.signedAt);
      expect(cipher.decrypt('tenant-1', signature.signerName)).toBe('Ana Pérez');
      expect(cipher.isEncrypted(signature.signerIdentification)).toBe(true);
      expect(signature.signatureStorageKey.startsWith('tenant-1/consents/doc-1/signature')).toBe(
        true,
      );
      expect(
        cipher.decryptBuffer('tenant-1', objects.get(signature.signatureStorageKey)!).equals(PNG),
      ).toBe(true);

      expect(db.treatmentSession.update.mock.calls[0][0]).toEqual({
        where: { id: 'session-1', version: 3 },
        data: {
          status: 'CONSENTED',
          consentDocument: { connect: { id: 'doc-1' } },
          version: { increment: 1 },
        },
      });
      expect(db.consentEvent.create.mock.calls[0][0].data).toEqual({
        tenantId: 'tenant-1',
        documentId: 'doc-1',
        type: 'SIGNED',
        actorId: 'pro',
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          entity: 'CONSENT_DOCUMENT',
          entityId: 'doc-1',
        }),
        expect.objectContaining({
          action: 'UPDATE',
          entity: 'TREATMENT_SESSION',
          entityId: 'session-1',
        }),
      ]);
      const audited = decryptedAudit();
      expect(audited).not.toContain(PNG.toString('base64'));
      expect(audited).not.toContain(pdfKey);
      expect(audited).toContain('CONSENTED');

      expect(signed).toMatchObject({ id: 'doc-1', status: 'SIGNED' });
      expect(signed.signature).toEqual({
        signerName: 'Ana Pérez',
        signerRole: 'PATIENT',
        relationship: null,
      });
      expect(signed).not.toHaveProperty('pdfStorageKey');
      expect(signed).not.toHaveProperty('body');
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'Serializable',
      });
    });

    it('returns the representative and relationship in the signature of the response', async () => {
      db.consentDocument.findFirst.mockResolvedValueOnce(document()).mockResolvedValueOnce(
        document({
          status: 'SIGNED',
          signedAt: new Date(),
          pdfChecksum: 'x',
          pdfStorageKey: 'k',
        }),
      );

      const signed = await sign(
        dto({
          signerRole: 'REPRESENTATIVE',
          signerName: ' Rosa Pérez ',
          signerIdentification: '0911223344',
          relationship: ' Madre ',
        }),
      );

      expect(signed.signature).toEqual({
        signerName: 'Rosa Pérez',
        signerRole: 'REPRESENTATIVE',
        relationship: 'Madre',
      });
      expect(JSON.stringify(signed)).not.toContain('0911223344');
    });

    it('refuses a second signature of the same document without writing anything', async () => {
      await sign();
      expect(storage.put).toHaveBeenCalledTimes(2);
      db.consentDocument.findFirst.mockResolvedValue(
        document({ status: 'SIGNED', signedAt: new Date(), pdfStorageKey: 'k', pdfChecksum: 'x' }),
      );

      await expect(sign()).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONSENT_DOCUMENT_INVALID_STATE', status: 'SIGNED' },
      });
      expect(storage.put).toHaveBeenCalledTimes(2);
      expect(db.consentSignature.create).toHaveBeenCalledTimes(1);
    });

    it('answers 409 and removes its files when another signature won the race', async () => {
      db.consentDocument.updateMany.mockResolvedValue({ count: 0 });

      await expect(sign()).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONSENT_DOCUMENT_INVALID_STATE' },
      });
      expect(storage.put).toHaveBeenCalledTimes(2);
      expect(objects.size).toBe(0);
      expect(db.consentSignature.create).not.toHaveBeenCalled();
      expect(db.treatmentSession.update).not.toHaveBeenCalled();
    });

    it('removes the stored files when the transaction fails', async () => {
      db.consentSignature.create.mockRejectedValue(new Error('database down'));

      await expect(sign()).rejects.toThrow('database down');
      expect(storage.put).toHaveBeenCalledTimes(2);
      expect(storage.remove).toHaveBeenCalledTimes(2);
      expect(objects.size).toBe(0);
    });

    it('requires both declarations', async () => {
      await expect(sign(dto({ questionsAnswered: false }))).rejects.toMatchObject({
        status: 422,
        response: { code: 'CONSENT_DECLARATIONS_REQUIRED' },
      });
      await expect(sign(dto({ understood: false }))).rejects.toMatchObject({
        status: 422,
        response: { code: 'CONSENT_DECLARATIONS_REQUIRED' },
      });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('requires a representative for a minor at the server date', async () => {
      const seventeen = new Date();
      seventeen.setUTCFullYear(seventeen.getUTCFullYear() - 17);
      db.patient.findFirst.mockResolvedValue({ ...adult, dateOfBirth: seventeen });

      await expect(sign()).rejects.toMatchObject({
        status: 422,
        response: { code: 'CONSENT_REPRESENTATIVE_REQUIRED' },
      });
      expect(storage.put).not.toHaveBeenCalled();

      await sign(
        dto({ signerRole: 'REPRESENTATIVE', signerName: 'María Pérez', relationship: 'Madre' }),
      );
      const signature = db.consentSignature.create.mock.calls[0][0].data;
      expect(signature.signerRole).toBe('REPRESENTATIVE');
      expect(cipher.decrypt('tenant-1', signature.relationship)).toBe('Madre');
    });

    it('lets the patient sign when no date of birth is on file', async () => {
      db.patient.findFirst.mockResolvedValue({ ...adult, dateOfBirth: null });

      await sign();

      expect(db.consentSignature.create).toHaveBeenCalledTimes(1);
    });

    it('requires the relationship of a representative', async () => {
      await expect(sign(dto({ signerRole: 'REPRESENTATIVE' }))).rejects.toMatchObject({
        status: 400,
      });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('accepts only a PNG drawing as the signature', async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
      for (const signature of [
        `data:image/png;base64,${jpeg.toString('base64')}`,
        `data:image/jpeg;base64,${PNG.toString('base64')}`,
        'data:image/png;base64,not base64!',
      ]) {
        await expect(sign(dto({ signature }))).rejects.toMatchObject({
          status: 400,
          response: { code: 'CONSENT_SIGNATURE_INVALID' },
        });
      }
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('is refused to anyone but the professional of the session', async () => {
      await expect(sign(dto(), colleague)).rejects.toMatchObject({ status: 403 });
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('does not find a document of another tenant', async () => {
      db.consentDocument.findFirst.mockResolvedValue(null);

      await expect(sign()).rejects.toMatchObject({
        status: 404,
        response: { code: 'CONSENT_DOCUMENT_NOT_FOUND' },
      });
      expect(db.consentDocument.findFirst.mock.calls[0][0].where).toEqual({
        id: 'doc-1',
        tenantId: 'tenant-1',
      });
    });

    it('takes the declarations only as real booleans', () => {
      const parsed = plainToInstance(
        SignConsentDto,
        { ...dto(), understood: 'false', questionsAnswered: 'true' },
        { enableImplicitConversion: true },
      );
      const errors = validateSync(parsed).map((error) => error.property);

      expect(errors).toEqual(expect.arrayContaining(['understood', 'questionsAnswered']));
    });
  });

  describe('refuse', () => {
    it('refuses the document, ends the session and closes its encounter', async () => {
      db.consentDocument.findFirst
        .mockResolvedValueOnce(document())
        .mockResolvedValueOnce(document({ status: 'REFUSED', refusedAt: new Date() }));
      db.treatmentSession.findFirst.mockResolvedValue(loaded(consentPolicy));

      const refused = await service.refuse('tenant-1', 'doc-1', professional, {
        reason: 'Prefiere pensarlo',
      });

      const claim = db.consentDocument.updateMany.mock.calls[0][0];
      expect(claim.where).toEqual({ id: 'doc-1', tenantId: 'tenant-1', status: 'PRESENTED' });
      expect(claim.data).toEqual({ status: 'REFUSED', refusedAt: expect.any(Date) });
      expect(db.treatmentSession.update.mock.calls[0][0].data).toEqual({
        status: 'CONSENT_REFUSED',
        version: { increment: 1 },
      });
      expect(db.encounter.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'encounter-1' },
        data: { status: 'CLOSED' },
      });
      const event = db.consentEvent.create.mock.calls[0][0].data;
      expect(event).toMatchObject({ documentId: 'doc-1', type: 'REFUSED', actorId: 'pro' });
      expect(cipher.decrypt('tenant-1', event.reason)).toBe('Prefiere pensarlo');
      expect(auditRows()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'UPDATE', entity: 'CONSENT_DOCUMENT' }),
          expect.objectContaining({ action: 'UPDATE', entity: 'TREATMENT_SESSION' }),
          expect.objectContaining({ action: 'UPDATE', entity: 'ENCOUNTER' }),
        ]),
      );
      expect(refused).toMatchObject({ id: 'doc-1', status: 'REFUSED' });
    });

    it('refuses only a presented document', async () => {
      db.consentDocument.findFirst.mockResolvedValue(document({ status: 'SIGNED' }));

      await expect(
        service.refuse('tenant-1', 'doc-1', professional, { reason: 'No desea' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONSENT_DOCUMENT_INVALID_STATE' },
      });
      expect(db.consentDocument.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('revoke', () => {
    /** Sessions stored by id; findFirst and findMany answer from them as the database would. */
    const storeSessions = (rows: ReturnType<typeof loaded>[]) => {
      db.treatmentSession.findFirst.mockImplementation(({ where }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      );
      db.treatmentSession.findMany.mockImplementation(({ where }) =>
        Promise.resolve(
          rows
            .filter(
              (row) =>
                row.tenantId === where.tenantId &&
                row.consentDocumentId === where.consentDocumentId &&
                row.status === where.status &&
                row.id !== where.id.not,
            )
            .map(({ treatmentVersion: _version, ...row }) => row),
        ),
      );
    };

    const signedDocument = () =>
      document({ status: 'SIGNED', signedAt: new Date(), pdfStorageKey: 'k', pdfChecksum: 'x' });

    beforeEach(() => {
      db.consentDocument.findFirst
        .mockResolvedValueOnce(signedDocument())
        .mockResolvedValueOnce(document({ status: 'REVOKED', revokedAt: new Date() }));
    });

    it('revokes a consented session and closes its encounter', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(consentPolicy, { status: 'CONSENTED', consentDocumentId: 'doc-1' }),
      );

      const revoked = await service.revoke('tenant-1', 'doc-1', professional, {
        reason: 'Cambió de opinión',
      });

      const claim = db.consentDocument.updateMany.mock.calls[0][0];
      expect(claim.where).toEqual({ id: 'doc-1', tenantId: 'tenant-1', status: 'SIGNED' });
      expect(claim.data).toEqual({ status: 'REVOKED', revokedAt: expect.any(Date) });
      expect(db.treatmentSession.update.mock.calls[0][0].data).toEqual({
        status: 'CONSENT_REVOKED',
        version: { increment: 1 },
      });
      expect(db.encounter.update).toHaveBeenCalledTimes(1);
      const event = db.consentEvent.create.mock.calls[0][0].data;
      expect(event.type).toBe('REVOKED');
      expect(cipher.decrypt('tenant-1', event.reason)).toBe('Cambió de opinión');
      expect(revoked).toMatchObject({ status: 'REVOKED' });
    });

    it('leaves a session that already started as it is', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(consentPolicy, { status: 'IN_PROGRESS', consentDocumentId: 'doc-1' }),
      );

      await service.revoke('tenant-1', 'doc-1', professional, { reason: 'Cambió de opinión' });

      expect(db.consentDocument.updateMany).toHaveBeenCalledTimes(1);
      expect(db.treatmentSession.update).not.toHaveBeenCalled();
      expect(db.encounter.update).not.toHaveBeenCalled();
      expect(auditRows()).toEqual([
        expect.objectContaining({ action: 'UPDATE', entity: 'CONSENT_DOCUMENT' }),
      ]);
    });

    it('returns the sessions that reused the consent and have not started to the consent step', async () => {
      storeSessions([
        loaded(consentPolicy, { status: 'CONSENTED', consentDocumentId: 'doc-1' }),
        loaded(consentPolicy, {
          id: 'session-2',
          encounterId: 'encounter-2',
          status: 'CONSENTED',
          consentDocumentId: 'doc-1',
          version: 7,
        }),
        loaded(consentPolicy, {
          id: 'session-3',
          encounterId: 'encounter-3',
          status: 'IN_PROGRESS',
          consentDocumentId: 'doc-1',
          version: 9,
        }),
      ]);

      await service.revoke('tenant-1', 'doc-1', professional, { reason: 'Cambió de opinión' });

      expect(db.treatmentSession.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        consentDocumentId: 'doc-1',
        status: 'CONSENTED',
        id: { not: 'session-1' },
      });
      const updates = db.treatmentSession.update.mock.calls.map(([args]) => args);
      expect(updates).toEqual([
        {
          where: { id: 'session-1', version: 3 },
          data: { status: 'CONSENT_REVOKED', version: { increment: 1 } },
        },
        {
          where: { id: 'session-2', version: 7 },
          data: {
            status: 'READY_FOR_CONSENT',
            consentDocument: { disconnect: true },
            version: { increment: 1 },
          },
        },
      ]);
      // Only the document's own session ends, so only its encounter closes.
      expect(db.encounter.update).toHaveBeenCalledTimes(1);
      expect(db.encounter.findFirst.mock.calls[0][0].where.id).toBe('encounter-1');

      const reused = auditRows().find((row: { entityId: string }) => row.entityId === 'session-2');
      expect(reused).toMatchObject({ action: 'UPDATE', entity: 'TREATMENT_SESSION' });
      expect(cipher.decrypt('tenant-1', reused.reason)).toBe('Consentimiento revocado');
      const after = (cipher.decryptJson('tenant-1', reused.changes) as { after: object }).after;
      expect(after).toMatchObject({ status: 'READY_FOR_CONSENT', consentDocumentId: null });
      expect(auditRows().some((row: { entityId: string }) => row.entityId === 'session-3')).toBe(
        false,
      );
    });

    it('lets the account holder revoke and records them as the actor', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(consentPolicy, { status: 'CONSENTED', consentDocumentId: 'doc-1' }),
      );

      await service.revoke('tenant-1', 'doc-1', master, { reason: 'Solicitud del paciente' });

      expect(db.treatmentSession.update).toHaveBeenCalledTimes(1);
      expect(db.encounter.update).toHaveBeenCalledTimes(1);
      expect(db.consentEvent.create.mock.calls[0][0].data.actorId).toBe('owner');
      expect(new Set(auditRows().map((row: { userId: string }) => row.userId))).toEqual(
        new Set(['owner']),
      );
    });

    it('is refused to another professional', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(consentPolicy, { status: 'CONSENTED', consentDocumentId: 'doc-1' }),
      );

      await expect(
        service.revoke('tenant-1', 'doc-1', colleague, { reason: 'Cambió de opinión' }),
      ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });
      expect(db.consentDocument.updateMany).not.toHaveBeenCalled();
    });

    it('revokes only a signed document', async () => {
      db.consentDocument.findFirst.mockReset();
      db.consentDocument.findFirst.mockResolvedValue(document());

      await expect(
        service.revoke('tenant-1', 'doc-1', professional, { reason: 'Cambió de opinión' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONSENT_DOCUMENT_INVALID_STATE' },
      });
    });
  });

  describe('pdf', () => {
    const PDF = Buffer.from('%PDF-1.3\nconsentimiento firmado');
    let logged: jest.SpyInstance;
    beforeEach(() => {
      logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => logged.mockRestore());
    const stored = (pdfChecksum = sha256(PDF)) =>
      document({
        status: 'SIGNED',
        signedAt: new Date(),
        pdfStorageKey: 'tenant-1/consents/doc-1/pdf/attempt',
        pdfChecksum,
      });

    it('returns the decrypted PDF and audits the download', async () => {
      db.consentDocument.findFirst.mockResolvedValue(stored());
      objects.set('tenant-1/consents/doc-1/pdf/attempt', cipher.encryptBuffer('tenant-1', PDF));

      const file = await service.pdf('tenant-1', 'doc-1', colleague);

      expect(file).toEqual({ fileName: 'consentimiento-doc-1.pdf', data: PDF });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'READ',
          entity: 'CONSENT_DOCUMENT',
          entityId: 'doc-1',
          patientId: 'patient-1',
          userId: 'other',
        }),
      ]);
    });

    it('answers 500 CONSENT_PDF_INTEGRITY when the bytes no longer match', async () => {
      db.consentDocument.findFirst.mockResolvedValue(stored());
      objects.set(
        'tenant-1/consents/doc-1/pdf/attempt',
        cipher.encryptBuffer('tenant-1', Buffer.from('%PDF-1.3\nconsentimiento alterado')),
      );

      await expect(service.pdf('tenant-1', 'doc-1', professional)).rejects.toMatchObject({
        status: 500,
        response: { code: 'CONSENT_PDF_INTEGRITY' },
      });
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('doc-1'));
    });

    it('answers 500 CONSENT_PDF_INTEGRITY when the stored ciphertext was altered', async () => {
      db.consentDocument.findFirst.mockResolvedValue(stored());
      const encrypted = cipher.encryptBuffer('tenant-1', PDF);
      encrypted[encrypted.length - 1] ^= 0xff;
      objects.set('tenant-1/consents/doc-1/pdf/attempt', encrypted);

      await expect(service.pdf('tenant-1', 'doc-1', professional)).rejects.toMatchObject({
        status: 500,
        response: { code: 'CONSENT_PDF_INTEGRITY' },
      });
    });

    it('has no PDF before the document is signed', async () => {
      db.consentDocument.findFirst.mockResolvedValue(document());

      await expect(service.pdf('tenant-1', 'doc-1', professional)).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONSENT_DOCUMENT_INVALID_STATE' },
      });
    });
  });
});
