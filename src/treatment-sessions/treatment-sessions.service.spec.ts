import { Prisma } from '@prisma/client';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { ConsentTemplatesService } from '../consents/consent-templates.service';
import { EncountersService } from '../encounters/encounters.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpecialtyRecordsService } from '../specialty-records/specialty-records.service';
import { TreatmentRequirements } from '../treatments/treatment-requirements';
import { TreatmentsService } from '../treatments/treatments.service';
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
});
