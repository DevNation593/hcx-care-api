import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { randomBytes } from 'crypto';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher, parseClinicalKeys } from '../clinical-access/clinical-cipher';
import { ConsentTemplatesService } from '../consents/consent-templates.service';
import { EncountersService } from '../encounters/encounters.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpecialtyRecordsService } from '../specialty-records/specialty-records.service';
import { TreatmentRequirements } from '../treatments/treatment-requirements';
import { TreatmentsService } from '../treatments/treatments.service';
import {
  CancelTreatmentSessionDto,
  CompleteTreatmentSessionDto,
} from './dto/treatment-session.dto';
import { TreatmentSessionsService } from './treatment-sessions.service';

describe('TreatmentSessionsService', () => {
  const plain = new ClinicalCipher();
  const professional: ClinicalActor = {
    userId: 'pro',
    role: 'PROFESIONAL',
    specialtyId: 'aesthetics',
  };
  const other: ClinicalActor = { ...professional, userId: 'other' };
  const DAY_MS = 24 * 60 * 60 * 1000;

  const fullPolicy: TreatmentRequirements = {
    medicalForm: { required: true },
    informedConsent: { required: true, validityDays: null },
    photos: { minimumBefore: 1, minimumAfter: 1 },
    clinicalNotes: { requiredForCompletion: true },
  };
  const reusablePolicy: TreatmentRequirements = {
    medicalForm: { required: false },
    informedConsent: { required: true, validityDays: 30 },
    photos: { minimumBefore: 0, minimumAfter: 0 },
    clinicalNotes: { requiredForCompletion: false },
  };
  const formSchema = {
    sections: [
      {
        key: 'history',
        title: 'Antecedentes',
        fields: [
          {
            key: 'pregnant',
            label: 'Embarazo',
            type: 'select',
            required: true,
            options: [
              { value: 'NO', label: 'No' },
              { value: 'SI', label: 'Sí' },
            ],
          },
        ],
      },
    ],
  };

  const treatment = (overrides = {}) => ({
    id: 'treatment-1',
    tenantId: 'tenant-1',
    name: 'Toxina botulínica',
    category: null,
    specialtyId: null,
    isActive: true,
    currentVersion: 1,
    ...overrides,
  });
  const version = (requirements: TreatmentRequirements, overrides = {}) => ({
    id: 'version-1',
    tenantId: 'tenant-1',
    treatmentId: 'treatment-1',
    version: 1,
    price: new Prisma.Decimal('120.00'),
    taxRatePercent: new Prisma.Decimal('15.00'),
    durationMinutes: 30,
    formDefinitionId: requirements.medicalForm.required ? 'form-1' : null,
    formVersion: requirements.medicalForm.required ? 2 : null,
    consentTemplateVersionId: 'consent-v1',
    requirements,
    createdById: 'master',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  });
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
    status: 'INTAKE_IN_PROGRESS',
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    procedureNotes: null,
    cancellationReason: null,
    version: 1,
    createdAt: new Date('2026-10-15T14:00:00Z'),
    updatedAt: new Date('2026-10-15T14:00:00Z'),
    ...overrides,
  });
  const loaded = (requirements: TreatmentRequirements, overrides = {}) => ({
    ...session(overrides),
    treatmentVersion: { ...version(requirements), treatment: treatment() },
  });
  const patient = {
    id: 'patient-1',
    firstName: 'Ana',
    lastName: 'Pérez',
    dateOfBirth: new Date('1990-05-01T00:00:00Z'),
    identificationNumber: '0102030405',
    guardianName: null,
    guardianRelationship: null,
    guardianIdentification: null,
  };

  const db = {
    patient: { findFirst: jest.fn() },
    branch: { findFirst: jest.fn() },
    appointment: { findFirst: jest.fn(), updateMany: jest.fn() },
    encounter: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    treatment: { findFirst: jest.fn() },
    treatmentVersion: { findFirst: jest.fn(), findUnique: jest.fn() },
    treatmentSession: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    specialtyRecord: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    formDefinitionVersion: { findFirst: jest.fn() },
    consentDocument: { findMany: jest.fn() },
    patientFile: { findMany: jest.fn(), count: jest.fn() },
    auditLog: { createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const prismaService = prisma as unknown as PrismaService;
  const audit = new ClinicalAuditService(prismaService, plain);
  const service = new TreatmentSessionsService(
    prismaService,
    audit,
    plain,
    new TreatmentsService(prismaService, new ConsentTemplatesService(prismaService)),
    new EncountersService(prismaService, audit, plain),
    new SpecialtyRecordsService(prismaService, audit, plain),
  );
  const auditRows = () => db.auditLog.createMany.mock.calls.flatMap(([args]) => args.data);
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { getStatus(): number; getResponse(): Record<string, unknown> };
    }
    throw new Error('expected the call to fail');
  };

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.patient.findFirst.mockResolvedValue(patient);
    db.encounter.findFirst.mockResolvedValue(null);
    db.encounter.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'encounter-1', status: 'OPEN', summary: null, ...data }),
    );
    db.treatment.findFirst.mockResolvedValue(treatment());
    db.treatmentVersion.findUnique.mockResolvedValue({ treatmentId: 'treatment-1' });
    db.treatmentSession.create.mockImplementation(({ data }) => Promise.resolve(session(data)));
    db.formDefinitionVersion.findFirst.mockResolvedValue({
      version: 2,
      schema: formSchema,
      formDefinition: { name: 'Ficha estética' },
    });
    db.consentDocument.findMany.mockResolvedValue([]);
    db.patientFile.findMany.mockResolvedValue([]);
    db.patientFile.count.mockResolvedValue(0);
    db.specialtyRecord.count.mockResolvedValue(0);
  });

  describe('create', () => {
    const create = (actor = professional) =>
      service.create('tenant-1', 'patient-1', actor, { treatmentId: 'treatment-1' });

    it('opens a PROCEDURE encounter and waits for the form the treatment requires', async () => {
      db.treatmentVersion.findFirst.mockResolvedValue(version(fullPolicy));

      const created = await create();

      expect(db.encounter.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'pro',
        specialtyId: 'aesthetics',
        encounterType: 'PROCEDURE',
        reason: 'Toxina botulínica',
      });
      expect(db.treatmentSession.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'pro',
        treatmentVersionId: 'version-1',
        encounterId: 'encounter-1',
      });
      expect(db.treatmentSession.update).not.toHaveBeenCalled();
      expect(prisma.$transaction.mock.calls[0][1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      expect(created).toMatchObject({
        id: 'session-1',
        status: 'INTAKE_IN_PROGRESS',
        patient,
        treatment: { id: 'treatment-1', name: 'Toxina botulínica', version: 1 },
        policy: fullPolicy,
        form: {
          formDefinitionId: 'form-1',
          formVersion: 2,
          name: 'Ficha estética',
          schema: formSchema,
          data: null,
        },
        consentDocuments: [],
        media: [],
        requirements: {
          start: ['FINALIZED_MEDICAL_FORM', 'SIGNED_APPLICABLE_CONSENT', 'BEFORE_PHOTOS'],
          complete: ['CLINICAL_NOTES', 'AFTER_PHOTOS'],
        },
        allowedCommands: ['SAVE_FORM', 'UPLOAD_OTHER', 'CANCEL', 'NO_SHOW'],
      });
      expect(auditRows()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'CREATE', entity: 'ENCOUNTER' }),
          expect.objectContaining({
            action: 'CREATE',
            entity: 'TREATMENT_SESSION',
            entityId: 'session-1',
            patientId: 'patient-1',
          }),
        ]),
      );
    });

    it('starts consented when an earlier consent of the same treatment is still valid', async () => {
      db.treatmentVersion.findFirst.mockResolvedValue(version(reusablePolicy));
      db.consentDocument.findMany.mockResolvedValue([
        {
          id: 'consent-doc-0',
          treatmentSessionId: 'session-0',
          templateVersionId: 'consent-v1',
          status: 'SIGNED',
          signedAt: new Date(Date.now() - 10 * DAY_MS),
          title: 'Consentimiento informado',
          checksum: 'abc',
        },
      ]);
      db.treatmentSession.update.mockImplementation(({ data }) => Promise.resolve(session(data)));

      const created = await create();

      expect(db.consentDocument.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        templateVersionId: 'consent-v1',
        treatmentSession: { treatmentVersion: { treatmentId: 'treatment-1' } },
      });
      expect(db.treatmentSession.update.mock.calls[0][0].data).toEqual({
        status: 'CONSENTED',
        consentDocumentId: 'consent-doc-0',
      });
      expect(created).toMatchObject({
        status: 'CONSENTED',
        consentDocumentId: 'consent-doc-0',
        form: null,
        requirements: { start: [], complete: [] },
      });
    });

    it('refuses a professional outside the specialty of the treatment', async () => {
      db.treatment.findFirst.mockResolvedValue(treatment({ specialtyId: 'dermatology' }));
      db.treatmentVersion.findFirst.mockResolvedValue(version(fullPolicy));

      await expect(create()).rejects.toMatchObject({
        status: 403,
        response: { code: 'TREATMENT_SPECIALTY_MISMATCH' },
      });
      expect(db.encounter.create).not.toHaveBeenCalled();
      expect(db.treatmentSession.create).not.toHaveBeenCalled();
    });
  });

  describe('saveForm', () => {
    const save = (actor = professional) =>
      service.saveForm('tenant-1', 'session-1', actor, { data: { pregnant: 'NO' } });

    beforeEach(() => {
      db.encounter.findFirst.mockResolvedValue({ professionalId: 'pro', status: 'OPEN' });
      db.specialtyRecord.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'record-1', version: 1, notes: null, ...data }),
      );
      db.treatmentSession.update.mockImplementation(({ data }) =>
        Promise.resolve(
          session({ status: data.status, formRecordId: data.formRecord?.connect.id, version: 2 }),
        ),
      );
    });

    it('stores the pinned form and moves the intake on to the consent', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy));
      db.specialtyRecord.count.mockResolvedValue(1);
      db.specialtyRecord.findFirst.mockResolvedValue({
        id: 'record-1',
        tenantId: 'tenant-1',
        data: { pregnant: 'NO' },
      });

      const saved = await save();

      expect(db.specialtyRecord.create.mock.calls[0][0].data).toMatchObject({
        moduleKey: 'custom.form-1',
        formDefinitionId: 'form-1',
        schemaVersion: 2,
        encounterId: 'encounter-1',
        data: { pregnant: 'NO' },
      });
      expect(db.treatmentSession.update.mock.calls[0][0]).toEqual({
        where: { id: 'session-1', version: 1 },
        data: {
          formRecord: { connect: { id: 'record-1' } },
          status: 'READY_FOR_CONSENT',
          version: { increment: 1 },
        },
      });
      expect(saved).toMatchObject({
        status: 'READY_FOR_CONSENT',
        formRecordId: 'record-1',
        form: { data: { pregnant: 'NO' } },
        requirements: { start: ['SIGNED_APPLICABLE_CONSENT', 'BEFORE_PHOTOS'] },
      });
      expect(auditRows()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'CREATE', entity: 'SPECIALTY_RECORD' }),
          expect.objectContaining({ action: 'UPDATE', entity: 'TREATMENT_SESSION' }),
        ]),
      );
    });

    it('is refused once the procedure has started', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(fullPolicy, { status: 'IN_PROGRESS', formRecordId: 'record-1' }),
      );

      await expect(save()).rejects.toMatchObject({
        status: 409,
        response: { code: 'TREATMENT_SESSION_INVALID_TRANSITION', status: 'IN_PROGRESS' },
      });
      expect(db.specialtyRecord.create).not.toHaveBeenCalled();
      expect(db.specialtyRecord.update).not.toHaveBeenCalled();
    });

    it('is refused to anyone but the professional of the session', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy));

      await expect(save(other)).rejects.toMatchObject({
        status: 403,
        response: { code: 'CLINICAL_RECORD_FORBIDDEN' },
      });
      expect(db.specialtyRecord.create).not.toHaveBeenCalled();
    });

    it('does not find a session of another tenant', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(null);

      await expect(save()).rejects.toMatchObject({
        status: 404,
        response: { code: 'TREATMENT_SESSION_NOT_FOUND' },
      });
      expect(db.treatmentSession.findFirst.mock.calls[0][0].where).toEqual({
        id: 'session-1',
        tenantId: 'tenant-1',
      });
    });
  });

  describe('get', () => {
    it('returns the detail and audits the read', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(fullPolicy, { status: 'READY_FOR_CONSENT', formRecordId: 'record-1' }),
      );
      db.specialtyRecord.count.mockResolvedValue(1);
      db.specialtyRecord.findFirst.mockResolvedValue({
        id: 'record-1',
        tenantId: 'tenant-1',
        data: { pregnant: 'SI' },
      });

      const found = await service.get('tenant-1', 'session-1', other);

      expect(found).toMatchObject({ id: 'session-1', form: { data: { pregnant: 'SI' } } });
      expect(found).not.toHaveProperty('treatmentVersion');
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'READ',
          entity: 'TREATMENT_SESSION',
          entityId: 'session-1',
          userId: 'other',
        }),
      ]);
    });
  });

  describe('compliance', () => {
    it('answers only the status and what is missing for the next step', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(fullPolicy, { status: 'READY_FOR_CONSENT', formRecordId: 'record-1' }),
      );
      db.specialtyRecord.count.mockResolvedValue(1);

      const before = await service.compliance('tenant-1', 'session-1');

      expect(before).toEqual({
        status: 'READY_FOR_CONSENT',
        missing: ['SIGNED_APPLICABLE_CONSENT', 'BEFORE_PHOTOS'],
      });
      expect(Object.keys(before).sort()).toEqual(['missing', 'status']);

      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(fullPolicy, {
          status: 'IN_PROGRESS',
          formRecordId: 'record-1',
          startedAt: new Date(),
        }),
      );
      await expect(service.compliance('tenant-1', 'session-1')).resolves.toEqual({
        status: 'IN_PROGRESS',
        missing: ['CLINICAL_NOTES', 'AFTER_PHOTOS'],
      });
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });
  });

  describe('transition', () => {
    it('refuses to write over a session that changed since it was read', async () => {
      db.treatmentSession.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
          code: 'P2025',
          clientVersion: '6.3.0',
        }),
      );

      const error = await failure(
        service.transition(db as never, session({ status: 'CONSENTED', version: 3 }) as never, {
          status: 'IN_PROGRESS',
        }),
      );

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_SESSION_INVALID_TRANSITION' });
      expect(db.treatmentSession.update.mock.calls[0][0]).toEqual({
        where: { id: 'session-1', version: 3 },
        data: { status: 'IN_PROGRESS', version: { increment: 1 } },
      });
    });
  });

  describe('clinical transitions', () => {
    const cipher = new ClinicalCipher(
      parseClinicalKeys(`test:${randomBytes(32).toString('base64')}`),
    );
    const keyedAudit = new ClinicalAuditService(prismaService, cipher);
    const sessions = new TreatmentSessionsService(
      prismaService,
      keyedAudit,
      cipher,
      new TreatmentsService(prismaService, new ConsentTemplatesService(prismaService)),
      new EncountersService(prismaService, keyedAudit, cipher),
      new SpecialtyRecordsService(prismaService, keyedAudit, cipher),
    );
    const signedConsent = (overrides = {}) => ({
      id: 'consent-doc-1',
      treatmentSessionId: 'session-1',
      templateVersionId: 'consent-v1',
      status: 'SIGNED',
      signedAt: new Date('2026-10-15T14:10:00Z'),
      title: 'Consentimiento informado',
      checksum: 'abc',
      ...overrides,
    });
    const photos = (before: number, after: number) =>
      db.patientFile.count.mockImplementation(({ where }) =>
        Promise.resolve(where.phase === 'BEFORE' ? before : after),
      );
    /** What the row looks like after `transition` wrote `data` over `base`. */
    const writes = (base: Record<string, unknown>) =>
      db.treatmentSession.update.mockImplementation(({ data }) => {
        const { consentDocument, version: _version, ...fields } = data;
        return Promise.resolve(
          session({
            ...base,
            ...fields,
            ...(consentDocument?.connect ? { consentDocumentId: consentDocument.connect.id } : {}),
            version: 2,
          }),
        );
      });
    const updateData = () => db.treatmentSession.update.mock.calls[0][0].data;
    const sessionAudit = () =>
      auditRows().filter((row: { entity: string }) => row.entity === 'TREATMENT_SESSION');
    const openEncounter = (overrides = {}) =>
      db.encounter.findFirst.mockResolvedValue({
        id: 'encounter-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'pro',
        appointmentId: null,
        status: 'OPEN',
        reason: null,
        summary: null,
        version: 1,
        treatmentSession: { id: 'session-1' },
        ...overrides,
      });

    beforeEach(() => {
      openEncounter();
      db.encounter.update.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'encounter-1',
          tenantId: 'tenant-1',
          patientId: 'patient-1',
          professionalId: 'pro',
          reason: null,
          summary: data.summary ?? null,
          status: data.status,
          closedAt: data.closedAt,
          version: 2,
        }),
      );
    });

    describe('start', () => {
      const start = () => sessions.start('tenant-1', 'session-1', professional);

      it('answers 422 with every missing requirement, in order', async () => {
        // The form record was removed and the consent revoked after the session was consented.
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(fullPolicy, {
            status: 'CONSENTED',
            formRecordId: 'record-1',
            consentDocumentId: 'consent-doc-1',
          }),
        );

        const error = await failure(start());

        expect(error.getStatus()).toBe(422);
        expect(error.getResponse()).toEqual({
          statusCode: 422,
          code: 'TREATMENT_REQUIREMENTS_MISSING',
          message: expect.any(String),
          missing: ['FINALIZED_MEDICAL_FORM', 'SIGNED_APPLICABLE_CONSENT', 'BEFORE_PHOTOS'],
        });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
        expect(db.auditLog.createMany).not.toHaveBeenCalled();
      });

      it('starts a satisfied session with the server time and pins its consent', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(fullPolicy, { status: 'CONSENTED', formRecordId: 'record-1' }),
        );
        db.specialtyRecord.count.mockResolvedValue(1);
        db.consentDocument.findMany.mockResolvedValue([signedConsent()]);
        photos(2, 0);
        writes({ status: 'CONSENTED', formRecordId: 'record-1' });
        const before = Date.now();

        const started = await start();

        expect(db.treatmentSession.update.mock.calls[0][0].where).toEqual({
          id: 'session-1',
          version: 1,
        });
        expect(updateData()).toEqual({
          status: 'IN_PROGRESS',
          startedAt: expect.any(Date),
          consentDocument: { connect: { id: 'consent-doc-1' } },
          version: { increment: 1 },
        });
        expect(updateData().startedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(updateData().startedAt.getTime()).toBeLessThanOrEqual(Date.now());
        expect(prisma.$transaction.mock.calls[0][1]).toEqual({
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
        expect(started).toMatchObject({
          status: 'IN_PROGRESS',
          consentDocumentId: 'consent-doc-1',
          startedAt: updateData().startedAt,
          requirements: { start: [], complete: ['CLINICAL_NOTES', 'AFTER_PHOTOS'] },
          allowedCommands: ['UPLOAD_AFTER', 'UPLOAD_OTHER', 'COMPLETE', 'CANCEL'],
        });
        expect(sessionAudit()).toEqual([
          expect.objectContaining({
            action: 'UPDATE',
            entityId: 'session-1',
            patientId: 'patient-1',
            userId: 'pro',
          }),
        ]);
        const { changes } = sessionAudit()[0];
        expect(cipher.decryptJson('tenant-1', changes)).toMatchObject({
          before: { status: 'CONSENTED', startedAt: null },
          after: { status: 'IN_PROGRESS', consentDocumentId: 'consent-doc-1' },
        });
      });

      it('refuses a second start', async () => {
        db.treatmentSession.findFirst
          .mockResolvedValueOnce(loaded(reusablePolicy, { status: 'CONSENTED' }))
          .mockResolvedValueOnce(
            loaded(reusablePolicy, { status: 'IN_PROGRESS', startedAt: new Date(), version: 2 }),
          );
        db.consentDocument.findMany.mockResolvedValue([signedConsent()]);
        writes({ status: 'CONSENTED' });

        await start();
        const error = await failure(start());

        expect(error.getStatus()).toBe(409);
        expect(error.getResponse()).toMatchObject({
          code: 'TREATMENT_SESSION_INVALID_TRANSITION',
          status: 'IN_PROGRESS',
          command: 'START',
        });
        expect(db.treatmentSession.update).toHaveBeenCalledTimes(1);
      });

      it('refuses a session sent back to the consent step by a revoked reused consent', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(reusablePolicy, { status: 'READY_FOR_CONSENT' }),
        );

        const error = await failure(start());

        expect(error.getStatus()).toBe(409);
        expect(error.getResponse()).toMatchObject({
          code: 'TREATMENT_SESSION_INVALID_TRANSITION',
          status: 'READY_FOR_CONSENT',
        });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
      });

      it('answers 422 when the consent of a consented session was revoked meanwhile', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(reusablePolicy, { status: 'CONSENTED', consentDocumentId: 'consent-doc-0' }),
        );
        // Only SIGNED documents are read: the revoked one does not come back.
        db.consentDocument.findMany.mockResolvedValue([]);

        const error = await failure(start());

        expect(error.getStatus()).toBe(422);
        expect(error.getResponse()).toMatchObject({ missing: ['SIGNED_APPLICABLE_CONSENT'] });
        expect(db.consentDocument.findMany.mock.calls[0][0].where).toMatchObject({
          status: 'SIGNED',
        });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
      });

      it('is refused to anyone but the professional of the session', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(reusablePolicy, { status: 'CONSENTED' }),
        );

        await expect(sessions.start('tenant-1', 'session-1', other)).rejects.toMatchObject({
          status: 403,
          response: { code: 'CLINICAL_RECORD_FORBIDDEN' },
        });
      });
    });

    describe('complete', () => {
      const inProgress = (overrides = {}) =>
        loaded(fullPolicy, {
          status: 'IN_PROGRESS',
          formRecordId: 'record-1',
          consentDocumentId: 'consent-doc-1',
          startedAt: new Date('2026-10-15T14:30:00Z'),
          ...overrides,
        });

      it('answers 422 without notes and after photos', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());

        const error = await failure(sessions.complete('tenant-1', 'session-1', professional, {}));

        expect(error.getStatus()).toBe(422);
        expect(error.getResponse()).toMatchObject({
          code: 'TREATMENT_REQUIREMENTS_MISSING',
          missing: ['CLINICAL_NOTES', 'AFTER_PHOTOS'],
        });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
        expect(db.encounter.update).not.toHaveBeenCalled();
      });

      it('does not count blank notes', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());
        photos(1, 1);

        const error = await failure(
          sessions.complete('tenant-1', 'session-1', professional, { procedureNotes: '   ' }),
        );

        expect(error.getResponse()).toMatchObject({ missing: ['CLINICAL_NOTES'] });
      });

      it('completes a satisfied session, stores the notes encrypted and closes the encounter', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());
        photos(1, 2);
        writes({ status: 'IN_PROGRESS', formRecordId: 'record-1' });
        const before = Date.now();

        const completed = await sessions.complete('tenant-1', 'session-1', professional, {
          procedureNotes: '  Toxina 20 U en glabela, sin incidencias.  ',
        });

        expect(updateData()).toEqual({
          status: 'CLINICAL_COMPLETE',
          completedAt: expect.any(Date),
          procedureNotes: expect.stringMatching(/^enc:v1:/),
          version: { increment: 1 },
        });
        expect(updateData().completedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(cipher.decrypt('tenant-1', updateData().procedureNotes)).toBe(
          'Toxina 20 U en glabela, sin incidencias.',
        );
        expect(db.encounter.update.mock.calls[0][0]).toMatchObject({
          where: { id: 'encounter-1' },
          data: { status: 'CLOSED', closedAt: expect.any(Date) },
        });
        expect(cipher.decrypt('tenant-1', db.encounter.update.mock.calls[0][0].data.summary)).toBe(
          'Toxina 20 U en glabela, sin incidencias.',
        );
        expect(completed).toMatchObject({
          status: 'CLINICAL_COMPLETE',
          procedureNotes: 'Toxina 20 U en glabela, sin incidencias.',
          allowedCommands: [],
        });
        expect(sessionAudit()).toEqual([
          expect.objectContaining({ action: 'UPDATE', entityId: 'session-1' }),
        ]);
        expect(auditRows()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ action: 'UPDATE', entity: 'ENCOUNTER' }),
          ]),
        );
      });

      it('completes with the notes already stored when the body brings none', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          inProgress({ procedureNotes: cipher.encrypt('tenant-1', 'Notas guardadas.') }),
        );
        photos(1, 1);
        writes({ status: 'IN_PROGRESS', procedureNotes: 'Notas guardadas.' });

        await sessions.complete('tenant-1', 'session-1', professional, {});

        expect(updateData()).not.toHaveProperty('procedureNotes');
        expect(cipher.decrypt('tenant-1', db.encounter.update.mock.calls[0][0].data.summary)).toBe(
          'Notas guardadas.',
        );
      });

      it('is refused before the procedure has started', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(reusablePolicy, { status: 'CONSENTED' }),
        );

        await expect(
          sessions.complete('tenant-1', 'session-1', professional, {}),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'TREATMENT_SESSION_INVALID_TRANSITION', command: 'COMPLETE' },
        });
      });

      it('takes notes of at most 10000 characters', () => {
        const valid = (procedureNotes: unknown) =>
          validateSync(plainToInstance(CompleteTreatmentSessionDto, { procedureNotes }));

        expect(valid('a'.repeat(10000))).toEqual([]);
        expect(valid('a'.repeat(10001))).not.toEqual([]);
        expect(valid(undefined)).toEqual([]);
        expect(plainToInstance(CompleteTreatmentSessionDto, { procedureNotes: ' x ' })).toEqual({
          procedureNotes: 'x',
        });
      });
    });

    describe('cancel', () => {
      it('cancels a session in progress with an encrypted reason and closes its encounter', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(fullPolicy, { status: 'IN_PROGRESS', startedAt: new Date() }),
        );
        writes({ status: 'IN_PROGRESS' });

        const cancelled = await sessions.cancel('tenant-1', 'session-1', professional, {
          reason: '  Reacción vasovagal  ',
        });

        expect(updateData()).toEqual({
          status: 'CANCELLED',
          cancelledAt: expect.any(Date),
          cancellationReason: expect.stringMatching(/^enc:v1:/),
          version: { increment: 1 },
        });
        expect(cipher.decrypt('tenant-1', updateData().cancellationReason)).toBe(
          'Reacción vasovagal',
        );
        expect(db.encounter.update.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED' });
        expect(cancelled).toMatchObject({
          status: 'CANCELLED',
          cancellationReason: 'Reacción vasovagal',
        });
        const [entry] = sessionAudit();
        expect(entry).toMatchObject({ action: 'UPDATE', entityId: 'session-1' });
        expect(cipher.decrypt('tenant-1', entry.reason)).toBe('Reacción vasovagal');
      });

      it('requires a reason of 3 to 1000 characters', () => {
        const errors = (body: Record<string, unknown>) =>
          validateSync(plainToInstance(CancelTreatmentSessionDto, body)).map(
            (error) => error.property,
          );

        expect(errors({})).toEqual(['reason']);
        expect(errors({ reason: '   ' })).toEqual(['reason']);
        expect(errors({ reason: 'ab' })).toEqual(['reason']);
        expect(errors({ reason: 'a'.repeat(1001) })).toEqual(['reason']);
        expect(errors({ reason: 'Paciente se retira' })).toEqual([]);
      });

      it('is refused once the session has ended', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(fullPolicy, { status: 'CLINICAL_COMPLETE' }),
        );

        await expect(
          sessions.cancel('tenant-1', 'session-1', professional, { reason: 'Error' }),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'TREATMENT_SESSION_INVALID_TRANSITION', command: 'CANCEL' },
        });
        expect(db.encounter.update).not.toHaveBeenCalled();
      });
    });

    describe('noShow', () => {
      it('marks the session and its unattended appointment as no-show and closes the encounter', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(fullPolicy, { status: 'INTAKE_IN_PROGRESS', appointmentId: 'appointment-1' }),
        );
        openEncounter({ appointmentId: 'appointment-1' });
        writes({ status: 'INTAKE_IN_PROGRESS', appointmentId: 'appointment-1' });

        const missed = await sessions.noShow('tenant-1', 'session-1', professional);

        expect(updateData()).toEqual({
          status: 'NO_SHOW',
          cancelledAt: expect.any(Date),
          version: { increment: 1 },
        });
        expect(db.appointment.updateMany.mock.calls[0][0]).toEqual({
          where: {
            id: 'appointment-1',
            tenantId: 'tenant-1',
            status: { in: ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'] },
          },
          data: { status: 'NO_SHOW' },
        });
        // The appointment is marked before the encounter closes, so it is not completed.
        expect(db.appointment.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
          db.encounter.update.mock.invocationCallOrder[0],
        );
        expect(db.encounter.update.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED' });
        expect(missed).toMatchObject({ status: 'NO_SHOW' });
        expect(sessionAudit()).toEqual([
          expect.objectContaining({ action: 'UPDATE', entityId: 'session-1' }),
        ]);
      });

      it('touches no appointment when the session has none', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(reusablePolicy, { status: 'CONSENTED' }),
        );
        writes({ status: 'CONSENTED' });

        await sessions.noShow('tenant-1', 'session-1', professional);

        expect(db.appointment.updateMany).not.toHaveBeenCalled();
        expect(updateData()).toMatchObject({ status: 'NO_SHOW' });
      });

      it('is refused once the procedure is in progress', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(fullPolicy, { status: 'IN_PROGRESS', startedAt: new Date() }),
        );

        await expect(sessions.noShow('tenant-1', 'session-1', professional)).rejects.toMatchObject({
          status: 409,
          response: { code: 'TREATMENT_SESSION_INVALID_TRANSITION', command: 'NO_SHOW' },
        });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
        expect(db.encounter.update).not.toHaveBeenCalled();
      });
    });
  });
});
