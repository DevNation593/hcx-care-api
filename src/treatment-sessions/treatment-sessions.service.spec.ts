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
  CreateTreatmentSessionDto,
  SaveProcedureNotesDto,
} from './dto/treatment-session.dto';
import { TreatmentSessionsService } from './treatment-sessions.service';

// Signing reads the bytes of files that have no hash yet.
const fileBytes = { get: jest.fn() };

describe('TreatmentSessionsService', () => {
  const plain = new ClinicalCipher();
  const professional: ClinicalActor = {
    userId: 'pro',
    role: 'PROFESIONAL',
    specialtyId: 'aesthetics',
  };
  const other: ClinicalActor = { ...professional, userId: 'other' };
  const master: ClinicalActor = { ...professional, userId: 'owner', role: 'MASTER' };
  const DAY_MS = 24 * 60 * 60 * 1000;

  const fullPolicy: TreatmentRequirements = {
    medicalForm: { required: true },
    informedConsent: { required: true, validityDays: null },
    photos: { minimumBefore: 1, minimumAfter: 1 },
    clinicalNotes: { requiredForCompletion: true },
    billingGate: { requireClinicalCompletion: true },
  };
  const reusablePolicy: TreatmentRequirements = {
    medicalForm: { required: false },
    informedConsent: { required: true, validityDays: 30 },
    photos: { minimumBefore: 0, minimumAfter: 0 },
    clinicalNotes: { requiredForCompletion: false },
    billingGate: { requireClinicalCompletion: true },
  };
  const earlyBilling: TreatmentRequirements = {
    ...fullPolicy,
    billingGate: { requireClinicalCompletion: false },
  };
  // An invoice blocks the session only while it is pending or authorized.
  const blockingInvoiceWhere = {
    tenantId: 'tenant-1',
    order: { items: { some: { treatmentSessionId: 'session-1', releasedAt: null } } },
    status: { in: ['REQUESTED', 'PROCESSING', 'AUTHORIZED'] },
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
    user: { findFirst: jest.fn() },
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
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    clinicalNote: { findMany: jest.fn(), count: jest.fn() },
    formDefinitionVersion: { findFirst: jest.fn() },
    consentDocument: { findMany: jest.fn() },
    tenant: { findUnique: jest.fn() },
    patientFile: { findMany: jest.fn(), count: jest.fn() },
    clinicalOrder: { findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
    auditLog: { createMany: jest.fn() },
    invoiceRequest: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const prismaService = prisma as unknown as PrismaService;
  const audit = new ClinicalAuditService(prismaService, plain);
  const service = new TreatmentSessionsService(
    prismaService,
    audit,
    plain,
    new TreatmentsService(prismaService, new ConsentTemplatesService(prismaService)),
    new EncountersService(prismaService, audit, plain, fileBytes),
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
    db.user.findFirst.mockResolvedValue({ id: 'pro', firstName: 'Laura', lastName: 'Mora' });
    // No open encounter is found for the patient; the one a session detail reads by id is open.
    db.encounter.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(where.id ? { status: 'OPEN' } : null),
    );
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
    // Closing the encounter checks that no treatment of it is left unfinished.
    db.treatmentSession.findMany.mockResolvedValue([]);
    db.tenant.findUnique.mockResolvedValue({ settings: { timezone: 'America/Guayaquil' } });
    db.patientFile.findMany.mockResolvedValue([]);
    db.clinicalOrder.findMany.mockResolvedValue([]);
    db.patientFile.count.mockResolvedValue(0);
    db.specialtyRecord.count.mockResolvedValue(0);
    db.clinicalNote.count.mockResolvedValue(0);
    db.clinicalOrder.count.mockResolvedValue(0);
    // Closing the encounter signs what it holds; row locks are granted.
    db.specialtyRecord.findMany.mockResolvedValue([]);
    db.clinicalNote.findMany.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([{ id: 'locked' }]);
    db.patientFile.findMany.mockResolvedValue([]);
    db.clinicalOrder.findMany.mockResolvedValue([]);
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

    describe('several treatments', () => {
      const ids = ['treatment-a', 'treatment-b'];
      const names: Record<string, string> = { 'treatment-a': 'Toxina', 'treatment-b': 'Relleno' };
      const specialties: Record<string, string | null> = {};
      let open: jest.SpyInstance;
      let sessionCount: number;

      const createMany = (extra = {}, actor = professional) =>
        service.create('tenant-1', 'patient-1', actor, { treatmentIds: ids, ...extra });
      const openEncounterRow = (overrides = {}) => ({
        id: 'encounter-9',
        professionalId: 'pro',
        status: 'OPEN',
        appointmentId: 'appointment-9',
        branchId: 'branch-9',
        ...overrides,
      });

      beforeEach(() => {
        for (const id of ids) delete specialties[id];
        sessionCount = 0;
        db.treatment.findFirst.mockImplementation(({ where }) =>
          Promise.resolve(
            treatment({
              id: where.id,
              name: names[where.id],
              specialtyId: specialties[where.id] ?? null,
            }),
          ),
        );
        db.treatmentVersion.findFirst.mockImplementation(({ where }) =>
          Promise.resolve(
            version(reusablePolicy, { id: `version-${where.treatmentId}`, ...where }),
          ),
        );
        db.treatmentSession.create.mockImplementation(({ data }) => {
          sessionCount += 1;
          return Promise.resolve(session({ ...data, id: `session-${sessionCount}` }));
        });
        db.treatmentSession.update.mockImplementation(({ where, data }) =>
          Promise.resolve(session({ ...data, id: where.id })),
        );
        open = jest.spyOn(EncountersService.prototype, 'openEncounter');
      });
      afterEach(() => open.mockRestore());

      it('creates one session per treatment on a new encounter', async () => {
        const created = await createMany();

        expect(open).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[0][4]).toMatchObject({
          encounterType: 'PROCEDURE',
          reason: 'Toxina, Relleno',
        });
        expect(db.treatmentSession.create).toHaveBeenCalledTimes(2);
        const encounterIds = db.treatmentSession.create.mock.calls.map(
          ([args]) => args.data.encounterId,
        );
        expect(encounterIds).toEqual(['encounter-1', 'encounter-1']);
        expect(Array.isArray(created)).toBe(true);
        expect(created).toHaveLength(2);
        expect((created as unknown as { id: string }[]).map((c) => c.id)).toEqual([
          'session-1',
          'session-2',
        ]);
      });

      it('uses the given type and reason for the new encounter', async () => {
        await createMany({ encounterType: 'FIRST_VISIT', reason: 'Valoración' });

        expect(open.mock.calls[0][4]).toMatchObject({
          encounterType: 'FIRST_VISIT',
          reason: 'Valoración',
        });
      });

      it('adds sessions to an open encounter of the caller', async () => {
        db.encounter.findFirst.mockResolvedValue(openEncounterRow());

        const created = await createMany({ encounterId: 'encounter-9' });

        expect(open).not.toHaveBeenCalled();
        expect(db.encounter.findFirst.mock.calls[0][0].where).toMatchObject({
          id: 'encounter-9',
          tenantId: 'tenant-1',
        });
        expect(db.treatmentSession.create.mock.calls.map(([args]) => args.data)).toEqual([
          expect.objectContaining({
            encounterId: 'encounter-9',
            appointmentId: 'appointment-9',
            branchId: 'branch-9',
          }),
          expect.objectContaining({
            encounterId: 'encounter-9',
            appointmentId: 'appointment-9',
            branchId: 'branch-9',
          }),
        ]);
        expect(created).toHaveLength(2);
      });

      it('rejects adding to a closed encounter', async () => {
        db.encounter.findFirst.mockResolvedValue(openEncounterRow({ status: 'CLOSED' }));

        await expect(createMany({ encounterId: 'encounter-9' })).rejects.toMatchObject({
          status: 409,
          response: { code: 'ENCOUNTER_CLOSED' },
        });
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it('rejects an encounter that a concurrent close shut after the check', async () => {
        db.encounter.findFirst.mockResolvedValue(openEncounterRow());
        db.$queryRaw.mockResolvedValue([]);

        await expect(createMany({ encounterId: 'encounter-9' })).rejects.toMatchObject({
          status: 409,
          response: { code: 'ENCOUNTER_CLOSED' },
        });
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it("rejects an appointment or branch that differs from the encounter's", async () => {
        db.encounter.findFirst.mockResolvedValue(openEncounterRow());

        await expect(
          createMany({ encounterId: 'encounter-9', appointmentId: 'appointment-other' }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
          createMany({ encounterId: 'encounter-9', branchId: 'branch-other' }),
        ).rejects.toMatchObject({ status: 400 });
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it('rejects a type or reason together with an encounter', async () => {
        db.encounter.findFirst.mockResolvedValue(openEncounterRow());

        await expect(
          createMany({ encounterId: 'encounter-9', encounterType: 'FOLLOW_UP' }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
          createMany({ encounterId: 'encounter-9', reason: 'Otro' }),
        ).rejects.toMatchObject({ status: 400 });
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it('creates nothing when one treatment belongs to another specialty', async () => {
        specialties['treatment-b'] = 'dermatology';

        await expect(createMany()).rejects.toMatchObject({
          status: 403,
          response: { code: 'TREATMENT_SPECIALTY_MISMATCH' },
        });
        expect(open).not.toHaveBeenCalled();
        expect(db.encounter.create).not.toHaveBeenCalled();
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it('requires exactly one of treatmentId and treatmentIds', async () => {
        await expect(
          service.create('tenant-1', 'patient-1', professional, {}),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
          service.create('tenant-1', 'patient-1', professional, {
            treatmentId: 'treatment-a',
            treatmentIds: ids,
          }),
        ).rejects.toMatchObject({ status: 400 });
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it('treats a JSON null as absent', async () => {
        await expect(
          service.create('tenant-1', 'patient-1', professional, {
            treatmentId: null,
            treatmentIds: undefined,
          } as unknown as CreateTreatmentSessionDto),
        ).rejects.toMatchObject({ status: 400 });
        expect(db.treatment.findFirst).not.toHaveBeenCalled();
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it("rejects another professional's encounter", async () => {
        db.encounter.findFirst.mockResolvedValue(openEncounterRow({ professionalId: 'other' }));

        await expect(createMany({ encounterId: 'encounter-9' })).rejects.toMatchObject({
          status: 403,
          response: { code: 'CLINICAL_RECORD_FORBIDDEN' },
        });
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it('rejects an encounter of another patient or tenant as not found', async () => {
        db.encounter.findFirst.mockResolvedValue(null);

        await expect(createMany({ encounterId: 'encounter-9' })).rejects.toMatchObject({
          status: 404,
        });
        expect(db.encounter.findFirst.mock.calls[0][0].where).toMatchObject({
          tenantId: 'tenant-1',
          patientId: 'patient-1',
        });
        expect(db.treatmentSession.create).not.toHaveBeenCalled();
      });

      it('keeps the single-session response for treatmentId', async () => {
        const created = await service.create('tenant-1', 'patient-1', professional, {
          treatmentId: 'treatment-a',
        });

        expect(Array.isArray(created)).toBe(false);
        expect(created).toMatchObject({ id: 'session-1' });
      });

      it('truncates a default reason to 2000 characters', async () => {
        names['treatment-a'] = 'A'.repeat(1500);
        names['treatment-b'] = 'B'.repeat(1500);
        try {
          await createMany();
        } finally {
          names['treatment-a'] = 'Toxina';
          names['treatment-b'] = 'Relleno';
        }

        expect(open.mock.calls[0][4].reason).toHaveLength(2000);
      });
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

  describe('list', () => {
    it('returns the procedure notes decrypted, without the cancellation reason, and audits each session', async () => {
      const cipher = new ClinicalCipher(
        parseClinicalKeys(`test:${randomBytes(32).toString('base64')}`),
      );
      const keyedAudit = new ClinicalAuditService(prismaService, cipher);
      const sessions = new TreatmentSessionsService(
        prismaService,
        keyedAudit,
        cipher,
        new TreatmentsService(prismaService, new ConsentTemplatesService(prismaService)),
        new EncountersService(prismaService, keyedAudit, cipher, fileBytes),
        new SpecialtyRecordsService(prismaService, keyedAudit, cipher),
      );
      const listed = (overrides = {}) => ({
        ...session(overrides),
        treatmentVersion: {
          version: 1,
          treatment: { id: 'treatment-1', name: 'Toxina botulínica' },
        },
        professional: { id: 'pro', firstName: 'Laura', lastName: 'Mora' },
      });
      db.treatmentSession.findMany.mockResolvedValue([
        listed({
          id: 'session-2',
          status: 'CLINICAL_COMPLETE',
          procedureNotes: cipher.encrypt('tenant-1', 'Sin incidencias.'),
        }),
        listed({
          status: 'CANCELLED',
          cancellationReason: cipher.encrypt('tenant-1', 'Reacción vasovagal.'),
        }),
      ]);

      const result = await sessions.list('tenant-1', 'patient-1', professional);

      expect(result).toEqual([
        expect.objectContaining({ id: 'session-2', procedureNotes: 'Sin incidencias.' }),
        expect.objectContaining({ id: 'session-1', procedureNotes: null }),
      ]);
      expect(result[0]).toMatchObject({
        treatment: { id: 'treatment-1', name: 'Toxina botulínica', version: 1 },
      });
      expect(result.every((item) => !('cancellationReason' in item))).toBe(true);
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'READ',
          entity: 'TREATMENT_SESSION',
          entityId: 'session-2',
        }),
        expect.objectContaining({
          action: 'READ',
          entity: 'TREATMENT_SESSION',
          entityId: 'session-1',
        }),
      ]);
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

    it('includes the decrypted signer of a signed document and null for a presented one', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy, { status: 'CONSENTED' }));
      db.consentDocument.findMany.mockResolvedValue([
        {
          id: 'consent-doc-2',
          treatmentSessionId: 'session-1',
          templateVersionId: 'consent-v1',
          status: 'PRESENTED',
          title: 'Consentimiento informado',
          checksum: 'abc',
          signature: null,
        },
        {
          id: 'consent-doc-1',
          treatmentSessionId: 'session-1',
          templateVersionId: 'consent-v1',
          status: 'SIGNED',
          signedAt: new Date('2026-10-15T14:10:00Z'),
          title: 'Consentimiento informado',
          checksum: 'abc',
          signature: {
            signerRole: 'REPRESENTATIVE',
            signerName: plain.encrypt('tenant-1', 'Rosa Pérez'),
            relationship: plain.encrypt('tenant-1', 'Madre'),
          },
        },
      ]);

      const found = await service.get('tenant-1', 'session-1', other);

      expect(found.consentDocuments.map((document) => document.signature)).toEqual([
        null,
        { signerName: 'Rosa Pérez', signerRole: 'REPRESENTATIVE', relationship: 'Madre' },
      ]);
      // Only the signer's name, role and relationship are selected: no identification, key or operator data.
      expect(db.consentDocument.findMany.mock.calls[0][0].select.signature).toEqual({
        select: { signerRole: true, signerName: true, relationship: true },
      });
    });

    it('returns a null relationship for a patient signer', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy, { status: 'CONSENTED' }));
      db.consentDocument.findMany.mockResolvedValue([
        {
          id: 'consent-doc-1',
          status: 'SIGNED',
          title: 'Consentimiento informado',
          signature: {
            signerRole: 'PATIENT',
            signerName: plain.encrypt('tenant-1', 'Ana Pérez'),
            relationship: null,
          },
        },
      ]);

      const found = await service.get('tenant-1', 'session-1', other);

      expect(found.consentDocuments[0].signature).toEqual({
        signerName: 'Ana Pérez',
        signerRole: 'PATIENT',
        relationship: null,
      });
    });

    it("returns the clinic's time zone from the tenant settings", async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy));
      db.tenant.findUnique.mockResolvedValue({ settings: { timezone: 'America/Bogota' } });

      const found = await service.get('tenant-1', 'session-1', other);

      expect(found.timezone).toBe('America/Bogota');
      expect(db.tenant.findUnique.mock.calls[0][0]).toMatchObject({ where: { id: 'tenant-1' } });
    });

    it('includes the professional who owns the session', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy));

      const found = await service.get('tenant-1', 'session-1', other);

      expect(found.professional).toEqual({ id: 'pro', firstName: 'Laura', lastName: 'Mora' });
      expect(db.user.findFirst.mock.calls[0][0]).toEqual({
        where: { id: 'pro', tenantId: 'tenant-1' },
        select: { id: true, firstName: true, lastName: true },
      });
    });

    it('offers the commands of the status only to the professional of the session', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy, { status: 'CONSENTED' }));

      expect((await service.get('tenant-1', 'session-1', professional)).allowedCommands).toEqual([
        'SAVE_FORM',
        'REVOKE_CONSENT',
        'UPLOAD_BEFORE',
        'UPLOAD_OTHER',
        'START',
        'CANCEL',
        'NO_SHOW',
      ]);
      expect((await service.get('tenant-1', 'session-1', other)).allowedCommands).toEqual([]);
    });

    it('leaves a MASTER who does not own the session only the consent revocation', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy, { status: 'CONSENTED' }));
      expect((await service.get('tenant-1', 'session-1', master)).allowedCommands).toEqual([
        'REVOKE_CONSENT',
      ]);

      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(fullPolicy, { status: 'READY_FOR_CONSENT' }),
      );
      expect((await service.get('tenant-1', 'session-1', master)).allowedCommands).toEqual([]);
    });

    it('detail lists the other sessions of the encounter', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy, { status: 'CONSENTED' }));
      db.encounter.findFirst.mockResolvedValue({ status: 'OPEN' });
      db.treatmentSession.findMany.mockResolvedValue([
        {
          id: 'session-2',
          status: 'IN_PROGRESS',
          treatmentVersion: { treatment: { name: 'Peeling químico' } },
        },
        {
          id: 'session-3',
          status: 'CANCELLED',
          treatmentVersion: { treatment: { name: 'Ácido hialurónico' } },
        },
      ]);

      const found = await service.get('tenant-1', 'session-1', other);

      expect(found.encounterStatus).toBe('OPEN');
      expect(found.encounterSessions).toEqual([
        { id: 'session-2', status: 'IN_PROGRESS', treatmentName: 'Peeling químico' },
        { id: 'session-3', status: 'CANCELLED', treatmentName: 'Ácido hialurónico' },
      ]);
      expect(db.encounter.findFirst.mock.calls[0][0]).toEqual({
        where: { id: 'encounter-1', tenantId: 'tenant-1' },
        select: { status: true },
      });
      // Its own session left out, within the tenant, in the order they were opened.
      expect(db.treatmentSession.findMany.mock.calls[0][0]).toEqual({
        where: { tenantId: 'tenant-1', encounterId: 'encounter-1', id: { not: 'session-1' } },
        select: {
          id: true,
          status: true,
          treatmentVersion: { select: { treatment: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('reports a closed encounter and no other sessions', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(fullPolicy, { status: 'CLINICAL_COMPLETE' }),
      );
      db.encounter.findFirst.mockResolvedValue({ status: 'CLOSED' });

      const found = await service.get('tenant-1', 'session-1', other);

      expect(found).toMatchObject({ encounterStatus: 'CLOSED', encounterSessions: [] });
    });

    it('falls back to America/Guayaquil when the tenant has no settings', async () => {
      db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy));
      db.tenant.findUnique.mockResolvedValue({ settings: null });

      const found = await service.get('tenant-1', 'session-1', other);

      expect(found.timezone).toBe('America/Guayaquil');
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

    it('answers nothing missing once the session is clinically complete', async () => {
      // The after photos were deleted after the close: billing must not regress.
      db.treatmentSession.findFirst.mockResolvedValue(
        loaded(fullPolicy, {
          status: 'CLINICAL_COMPLETE',
          formRecordId: 'record-1',
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      );
      db.specialtyRecord.count.mockResolvedValue(1);
      db.patientFile.count.mockResolvedValue(0);

      await expect(service.compliance('tenant-1', 'session-1')).resolves.toEqual({
        status: 'CLINICAL_COMPLETE',
        missing: [],
      });
    });
  });

  describe('compliance of billing statuses', () => {
    it.each(['BILLING_PENDING', 'BILLED', 'BILLING_FAILED'] as const)(
      'answers nothing missing for a %s session without reading facts',
      async (status) => {
        db.treatmentSession.findFirst.mockResolvedValue(loaded(fullPolicy, { status }));

        await expect(service.compliance('tenant-1', 'session-1')).resolves.toEqual({
          status,
          missing: [],
        });
        expect(db.specialtyRecord.count).not.toHaveBeenCalled();
        expect(db.patientFile.count).not.toHaveBeenCalled();
      },
    );
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
    const encounters = new EncountersService(prismaService, keyedAudit, cipher, fileBytes);
    const sessions = new TreatmentSessionsService(
      prismaService,
      keyedAudit,
      cipher,
      new TreatmentsService(prismaService, new ConsentTemplatesService(prismaService)),
      encounters,
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
    // The sessions of the encounter; none is left unfinished once they have been moved.
    const encounterSessions = (rows: Record<string, unknown>[]) =>
      db.treatmentSession.findMany
        .mockResolvedValueOnce(rows.map((row) => session(row)))
        .mockResolvedValue([]);
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

    afterEach(() => jest.restoreAllMocks());

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
          allowedCommands: ['UPLOAD_AFTER', 'UPLOAD_OTHER', 'SAVE_NOTES', 'COMPLETE', 'CANCEL'],
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

      it('completes without closing the encounter', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());
        photos(1, 2);
        writes({ status: 'IN_PROGRESS', formRecordId: 'record-1' });
        const close = jest.spyOn(encounters, 'closeEncounter');
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
        expect(close).not.toHaveBeenCalled();
        expect(db.encounter.update).not.toHaveBeenCalled();
        expect(completed).toMatchObject({
          status: 'CLINICAL_COMPLETE',
          procedureNotes: 'Toxina 20 U en glabela, sin incidencias.',
          encounterStatus: 'OPEN',
          allowedCommands: [],
        });
        expect(sessionAudit()).toEqual([
          expect.objectContaining({ action: 'UPDATE', entityId: 'session-1' }),
        ]);
        expect(auditRows().some((row: { entity: string }) => row.entity === 'ENCOUNTER')).toBe(
          false,
        );
      });

      it('ignores a password and summary sent without closeEncounter', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());
        photos(1, 1);
        writes({ status: 'IN_PROGRESS', formRecordId: 'record-1' });
        const close = jest.spyOn(encounters, 'closeEncounter');

        await sessions.complete('tenant-1', 'session-1', professional, {
          procedureNotes: 'Sin incidencias.',
          closeEncounter: false,
          password: 'secret',
          encounterSummary: 'Ok',
        });

        expect(close).not.toHaveBeenCalled();
        expect(db.encounter.update).not.toHaveBeenCalled();
      });

      it('completes and closes the encounter with its summary', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());
        photos(1, 1);
        writes({ status: 'IN_PROGRESS', formRecordId: 'record-1' });
        const close = jest.spyOn(encounters, 'closeEncounter');

        const completed = await sessions.complete('tenant-1', 'session-1', professional, {
          procedureNotes: 'Toxina 20 U en glabela, sin incidencias.',
          closeEncounter: true,
          encounterSummary: 'Ok',
        });

        // Inside the same serializable transaction, after the session itself has finished.
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(close.mock.calls).toEqual([[db, 'tenant-1', 'encounter-1', professional, 'Ok']]);
        expect(db.treatmentSession.update.mock.invocationCallOrder[0]).toBeLessThan(
          close.mock.invocationCallOrder[0],
        );
        expect(db.encounter.update.mock.calls[0][0]).toMatchObject({
          where: { id: 'encounter-1' },
          data: { status: 'CLOSED', closedAt: expect.any(Date) },
        });
        // The summary is the one sent, not the procedure notes.
        expect(cipher.decrypt('tenant-1', db.encounter.update.mock.calls[0][0].data.summary)).toBe(
          'Ok',
        );
        expect(completed).toMatchObject({ status: 'CLINICAL_COMPLETE' });
      });

      it('rolls back the completion when another session is unfinished', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());
        photos(1, 1);
        writes({ status: 'IN_PROGRESS', formRecordId: 'record-1' });
        // The close looks for the unfinished sessions of the encounter: a sibling is still open.
        db.treatmentSession.findMany.mockImplementation(({ where }) =>
          Promise.resolve(where.status ? [{ id: 'session-2' }] : []),
        );
        const close = jest.spyOn(encounters, 'closeEncounter');

        const error = await failure(
          sessions.complete('tenant-1', 'session-1', professional, {
            procedureNotes: 'Sin incidencias.',
            closeEncounter: true,
          }),
        );

        expect(error.getStatus()).toBe(409);
        expect(error.getResponse()).toMatchObject({
          code: 'ENCOUNTER_HAS_UNFINISHED_TREATMENTS',
          treatmentSessionIds: ['session-2'],
        });
        // Thrown inside the transaction callback, so the session update is rolled back with it.
        expect(close).toHaveBeenCalledTimes(1);
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(db.encounter.update).not.toHaveBeenCalled();
        expect(sessionAudit()).toEqual([]);
      });

      it('leaves an early-billed session pending while its invoice is in progress', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(earlyBilling, {
            status: 'IN_PROGRESS',
            formRecordId: 'record-1',
            consentDocumentId: 'consent-doc-1',
            startedAt: new Date('2026-10-15T14:30:00Z'),
          }),
        );
        photos(1, 1);
        writes({ status: 'IN_PROGRESS', formRecordId: 'record-1' });
        db.invoiceRequest.findFirst.mockResolvedValue({ id: 'invoice-1', status: 'PROCESSING' });

        await sessions.complete('tenant-1', 'session-1', professional, {
          procedureNotes: 'Sin incidencias.',
        });

        expect(db.invoiceRequest.findFirst.mock.calls[0][0].where).toEqual(blockingInvoiceWhere);
        expect(updateData().status).toBe('BILLING_PENDING');
      });

      it('completes with the notes already stored when the body brings none', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          inProgress({ procedureNotes: cipher.encrypt('tenant-1', 'Notas guardadas.') }),
        );
        photos(1, 1);
        writes({ status: 'IN_PROGRESS', procedureNotes: 'Notas guardadas.' });

        const completed = await sessions.complete('tenant-1', 'session-1', professional, {});

        expect(updateData()).not.toHaveProperty('procedureNotes');
        expect(completed).toMatchObject({ procedureNotes: 'Notas guardadas.' });
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

      it('takes closeEncounter only as a real boolean, a password and a summary of at most 5000 characters', () => {
        const errors = (body: Record<string, unknown>) =>
          validateSync(
            plainToInstance(CompleteTreatmentSessionDto, body, { enableImplicitConversion: true }),
          ).map((error) => error.property);

        expect(errors({ closeEncounter: true, password: 'x', encounterSummary: 'Ok' })).toEqual([]);
        expect(errors({ closeEncounter: false })).toEqual([]);
        expect(errors({})).toEqual([]);
        // Implicit conversion would read the text "false" as true.
        expect(errors({ closeEncounter: 'false' })).toEqual(['closeEncounter']);
        expect(errors({ closeEncounter: 1 })).toEqual(['closeEncounter']);
        expect(errors({ password: 'a'.repeat(201) })).toEqual(['password']);
        expect(errors({ encounterSummary: 'a'.repeat(5000) })).toEqual([]);
        expect(errors({ encounterSummary: 'a'.repeat(5001) })).toEqual(['encounterSummary']);
        expect(plainToInstance(CompleteTreatmentSessionDto, { encounterSummary: ' Ok ' })).toEqual({
          encounterSummary: 'Ok',
        });
      });
    });

    describe('saveNotes', () => {
      const inProgress = (overrides = {}) =>
        loaded(fullPolicy, {
          status: 'IN_PROGRESS',
          formRecordId: 'record-1',
          consentDocumentId: 'consent-doc-1',
          startedAt: new Date('2026-10-15T14:30:00Z'),
          ...overrides,
        });

      it('keeps the notes encrypted while the procedure is in progress, without closing anything', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());
        writes({ status: 'IN_PROGRESS', formRecordId: 'record-1' });

        const saved = await sessions.saveNotes('tenant-1', 'session-1', professional, {
          procedureNotes: '  Toxina 20 U en glabela.  ',
        });

        expect(db.treatmentSession.update.mock.calls[0][0].where).toEqual({
          id: 'session-1',
          version: 1,
        });
        expect(updateData()).toEqual({
          procedureNotes: expect.stringMatching(/^enc:v1:/),
          version: { increment: 1 },
        });
        expect(cipher.decrypt('tenant-1', updateData().procedureNotes)).toBe(
          'Toxina 20 U en glabela.',
        );
        expect(db.encounter.update).not.toHaveBeenCalled();
        expect(saved).toMatchObject({
          status: 'IN_PROGRESS',
          procedureNotes: 'Toxina 20 U en glabela.',
        });
        expect(sessionAudit()).toEqual([
          expect.objectContaining({ action: 'UPDATE', entityId: 'session-1', userId: 'pro' }),
        ]);
        expect(cipher.decryptJson('tenant-1', sessionAudit()[0].changes)).toMatchObject({
          before: { procedureNotes: null },
          after: { procedureNotes: 'Toxina 20 U en glabela.', status: 'IN_PROGRESS' },
        });
      });

      it('clears the notes when they are emptied', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          inProgress({ procedureNotes: cipher.encrypt('tenant-1', 'Borrador.') }),
        );
        writes({ status: 'IN_PROGRESS' });

        await sessions.saveNotes('tenant-1', 'session-1', professional, { procedureNotes: '  ' });

        expect(updateData()).toEqual({ procedureNotes: null, version: { increment: 1 } });
      });

      it('writes nothing when the notes did not change, and audits the detail it returns as read', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          inProgress({ procedureNotes: cipher.encrypt('tenant-1', 'Borrador.') }),
        );

        const saved = await sessions.saveNotes('tenant-1', 'session-1', professional, {
          procedureNotes: 'Borrador.',
        });

        expect(db.treatmentSession.update).not.toHaveBeenCalled();
        expect(sessionAudit()).toEqual([
          expect.objectContaining({
            action: 'READ',
            entityId: 'session-1',
            patientId: 'patient-1',
            userId: 'pro',
          }),
        ]);
        expect(saved).toMatchObject({ procedureNotes: 'Borrador.' });
      });

      it('is refused before the procedure has started and once it has ended', async () => {
        for (const status of ['CONSENTED', 'CLINICAL_COMPLETE']) {
          db.treatmentSession.findFirst.mockResolvedValue(loaded(reusablePolicy, { status }));

          await expect(
            sessions.saveNotes('tenant-1', 'session-1', professional, { procedureNotes: 'x' }),
          ).rejects.toMatchObject({
            status: 409,
            response: { code: 'TREATMENT_SESSION_INVALID_TRANSITION', command: 'SAVE_NOTES' },
          });
        }
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
      });

      it('is refused to anyone but the professional of the session', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(inProgress());

        await expect(
          sessions.saveNotes('tenant-1', 'session-1', other, { procedureNotes: 'x' }),
        ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });
      });

      it('takes empty notes and at most 10000 characters', () => {
        const valid = (procedureNotes: unknown) =>
          validateSync(plainToInstance(SaveProcedureNotesDto, { procedureNotes }));

        expect(valid('')).toEqual([]);
        expect(valid('a'.repeat(10000))).toEqual([]);
        expect(valid('a'.repeat(10001))).not.toEqual([]);
        expect(valid(undefined)).not.toEqual([]);
      });
    });

    describe('cancel', () => {
      it('is refused while an early-billed invoice is pending or authorized', async () => {
        db.treatmentSession.findFirst.mockResolvedValue(
          loaded(earlyBilling, { status: 'IN_PROGRESS', startedAt: new Date() }),
        );
        db.invoiceRequest.findFirst.mockResolvedValue({ id: 'invoice-1', status: 'REQUESTED' });

        const error = await failure(
          sessions.cancel('tenant-1', 'session-1', professional, { reason: 'Reacción' }),
        );

        expect(error.getStatus()).toBe(409);
        expect(db.invoiceRequest.findFirst.mock.calls[0][0].where).toEqual(blockingInvoiceWhere);
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
      });

      it('cancels a session in progress with an encrypted reason', async () => {
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
        expect(cancelled).toMatchObject({
          status: 'CANCELLED',
          cancellationReason: 'Reacción vasovagal',
        });
        const [entry] = sessionAudit();
        expect(entry).toMatchObject({ action: 'UPDATE', entityId: 'session-1' });
        expect(cipher.decrypt('tenant-1', entry.reason)).toBe('Reacción vasovagal');
      });

      it('cancels without touching the encounter or the appointment', async () => {
        for (const status of ['INTAKE_IN_PROGRESS', 'IN_PROGRESS']) {
          db.treatmentSession.findFirst.mockResolvedValue(
            loaded(fullPolicy, {
              status,
              startedAt: status === 'IN_PROGRESS' ? new Date() : null,
              appointmentId: 'appointment-1',
            }),
          );
          openEncounter({ appointmentId: 'appointment-1' });
          writes({ status, appointmentId: 'appointment-1' });
          const close = jest.spyOn(encounters, 'closeEncounter');

          const cancelled = await sessions.cancel('tenant-1', 'session-1', professional, {
            reason: 'Embarazo no informado',
          });

          // The appointment is resolved when the encounter closes, with every treatment in it.
          expect(close).not.toHaveBeenCalled();
          expect(db.appointment.updateMany).not.toHaveBeenCalled();
          expect(db.encounter.update).not.toHaveBeenCalled();
          expect(cancelled).toMatchObject({ status: 'CANCELLED', encounterStatus: 'OPEN' });
        }
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
        encounterSessions([{ status: 'INTAKE_IN_PROGRESS', appointmentId: 'appointment-1' }]);
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
        openEncounter();
        encounterSessions([{ status: 'CONSENTED' }]);
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

    describe('noShowEncounter', () => {
      const run = () =>
        sessions.noShowEncounter('tenant-1', 'patient-1', 'encounter-1', professional);

      beforeEach(() => {
        db.treatmentSession.findFirst.mockImplementation(({ where }) =>
          Promise.resolve(
            [
              loaded(fullPolicy, { id: 'session-1', appointmentId: 'appointment-1' }),
              loaded(reusablePolicy, {
                id: 'session-2',
                status: 'CONSENTED',
                appointmentId: 'appointment-1',
              }),
            ].find((row) => row.id === where.id),
          ),
        );
        db.treatmentSession.update.mockImplementation(({ where, data }) => {
          const { version: _version, ...fields } = data;
          return Promise.resolve(
            session({ id: where.id, appointmentId: 'appointment-1', ...fields }),
          );
        });
        openEncounter({ appointmentId: 'appointment-1' });
      });

      it('marks every unfinished session and the appointment as no-show and closes the encounter', async () => {
        encounterSessions([
          { id: 'session-1', status: 'INTAKE_IN_PROGRESS', appointmentId: 'appointment-1' },
          { id: 'session-2', status: 'CONSENTED', appointmentId: 'appointment-1' },
          { id: 'session-3', status: 'CANCELLED' },
        ]);

        const missed = await run();

        expect(db.treatmentSession.update.mock.calls.map(([args]) => args.where.id)).toEqual([
          'session-1',
          'session-2',
        ]);
        for (const [args] of db.treatmentSession.update.mock.calls) {
          expect(args.data).toEqual({
            status: 'NO_SHOW',
            cancelledAt: expect.any(Date),
            version: { increment: 1 },
          });
        }
        // Once for the appointment the sessions share; closing the encounter then finds it settled.
        expect(
          db.appointment.updateMany.mock.calls.filter(([args]) => args.data.status === 'NO_SHOW'),
        ).toHaveLength(1);
        expect(db.appointment.updateMany.mock.calls[0][0]).toEqual({
          where: {
            id: 'appointment-1',
            tenantId: 'tenant-1',
            status: { in: ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS'] },
          },
          data: { status: 'NO_SHOW' },
        });
        expect(db.appointment.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
          db.encounter.update.mock.invocationCallOrder[0],
        );
        expect(db.encounter.update.mock.calls[0][0].data).toMatchObject({ status: 'CLOSED' });
        expect(missed.map((row) => [row.id, row.status])).toEqual([
          ['session-1', 'NO_SHOW'],
          ['session-2', 'NO_SHOW'],
        ]);
        expect(sessionAudit().map((row: { entityId: string }) => row.entityId)).toEqual([
          'session-1',
          'session-2',
        ]);
        expect(db.treatmentSession.findMany.mock.calls[0][0]).toMatchObject({
          where: { tenantId: 'tenant-1', encounterId: 'encounter-1' },
          orderBy: { createdAt: 'asc' },
        });
      });

      it('refuses when a session already started', async () => {
        encounterSessions([
          { id: 'session-1', status: 'INTAKE_IN_PROGRESS' },
          { id: 'session-2', status: 'IN_PROGRESS' },
        ]);

        await expect(run()).rejects.toMatchObject({
          status: 409,
          response: { code: 'ENCOUNTER_HAS_ACTIVITY' },
        });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
        expect(db.encounter.update).not.toHaveBeenCalled();
      });

      it('refuses when a session is already finished', async () => {
        encounterSessions([{ id: 'session-1', status: 'CLINICAL_COMPLETE' }]);

        await expect(run()).rejects.toMatchObject({
          status: 409,
          response: { code: 'ENCOUNTER_HAS_ACTIVITY' },
        });
      });

      it('refuses when the encounter holds its own records', async () => {
        encounterSessions([
          { id: 'session-1', status: 'INTAKE_IN_PROGRESS', formRecordId: 'form-1' },
          { id: 'session-2', status: 'CONSENTED', formRecordId: 'form-2' },
        ]);
        db.specialtyRecord.count.mockResolvedValue(1);

        await expect(run()).rejects.toMatchObject({
          status: 409,
          response: { code: 'ENCOUNTER_HAS_ACTIVITY' },
        });
        expect(db.specialtyRecord.count.mock.calls[0][0].where).toEqual({
          tenantId: 'tenant-1',
          encounterId: 'encounter-1',
          deletedAt: null,
          id: { notIn: ['form-1', 'form-2'] },
        });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
        expect(db.encounter.update).not.toHaveBeenCalled();
      });

      it('lets the medical forms of its sessions through', async () => {
        encounterSessions([
          { id: 'session-1', status: 'INTAKE_IN_PROGRESS', formRecordId: 'form-1' },
        ]);

        await expect(run()).resolves.toHaveLength(1);
      });

      it('refuses when the encounter holds a note or an order', async () => {
        encounterSessions([{ id: 'session-1', status: 'INTAKE_IN_PROGRESS' }]);
        db.clinicalNote.count.mockResolvedValue(1);
        await expect(run()).rejects.toMatchObject({ response: { code: 'ENCOUNTER_HAS_ACTIVITY' } });
        expect(db.clinicalNote.count.mock.calls[0][0].where).toEqual({
          tenantId: 'tenant-1',
          encounterId: 'encounter-1',
          deletedAt: null,
        });

        encounterSessions([{ id: 'session-1', status: 'INTAKE_IN_PROGRESS' }]);
        db.clinicalNote.count.mockResolvedValue(0);
        db.clinicalOrder.count.mockResolvedValue(1);
        await expect(run()).rejects.toMatchObject({ response: { code: 'ENCOUNTER_HAS_ACTIVITY' } });
        expect(db.clinicalOrder.count.mock.calls[0][0].where).toEqual({
          tenantId: 'tenant-1',
          encounterId: 'encounter-1',
        });
      });

      it('locks the encounter exclusively up front, as closing it does', async () => {
        encounterSessions([{ id: 'session-1', status: 'INTAKE_IN_PROGRESS' }]);

        await run();

        const [strings, ...values] = db.$queryRaw.mock.calls[0];
        expect(strings.join('?')).toContain('FOR UPDATE');
        expect(strings.join('?')).not.toContain('FOR SHARE');
        expect(strings.join('?')).toContain(`"status" = 'OPEN'`);
        expect(values).toEqual(['encounter-1', 'tenant-1']);
      });

      it('answers ENCOUNTER_CLOSED when the encounter closed meanwhile', async () => {
        encounterSessions([{ id: 'session-1', status: 'INTAKE_IN_PROGRESS' }]);
        db.$queryRaw.mockResolvedValue([]);

        await expect(run()).rejects.toMatchObject({
          status: 409,
          response: { code: 'ENCOUNTER_CLOSED' },
        });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
      });

      it('refuses an encounter without treatments', async () => {
        encounterSessions([]);

        await expect(run()).rejects.toMatchObject({
          status: 409,
          response: { code: 'ENCOUNTER_HAS_NO_TREATMENTS' },
        });
      });

      it('refuses the encounter of another professional', async () => {
        encounterSessions([{ id: 'session-1', status: 'INTAKE_IN_PROGRESS' }]);

        await expect(
          sessions.noShowEncounter('tenant-1', 'patient-1', 'encounter-1', other),
        ).rejects.toMatchObject({ status: 403 });
        expect(db.treatmentSession.update).not.toHaveBeenCalled();
      });

      it('session no-show delegates to its encounter', async () => {
        encounterSessions([
          { id: 'session-1', status: 'INTAKE_IN_PROGRESS', appointmentId: 'appointment-1' },
          { id: 'session-2', status: 'CONSENTED', appointmentId: 'appointment-1' },
        ]);
        const delegate = jest.spyOn(sessions, 'noShowEncounter');

        const missed = await sessions.noShow('tenant-1', 'session-1', professional);

        expect(delegate).toHaveBeenCalledWith('tenant-1', 'patient-1', 'encounter-1', professional);
        expect(db.treatmentSession.update).toHaveBeenCalledTimes(2);
        expect(missed).toMatchObject({ id: 'session-1', status: 'NO_SHOW' });
      });
    });
  });
});
