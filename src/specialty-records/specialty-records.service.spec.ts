import { SpecialtyRecordsService } from './specialty-records.service';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalAuditService } from '../clinical-access/clinical-audit.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { PrismaService } from '../prisma/prisma.service';

describe('SpecialtyRecordsService', () => {
  const plain = new ClinicalCipher();
  const nutritionist: ClinicalActor = {
    userId: 'nutritionist',
    role: 'PROFESIONAL',
    specialtyId: 'nutrition',
  };
  const psychologist: ClinicalActor = { ...nutritionist, userId: 'psy', specialtyId: 'psychology' };
  const dentist: ClinicalActor = { ...nutritionist, userId: 'dentist', specialtyId: 'dentistry' };
  const dto = {
    specialtyCode: 'nutrition',
    moduleKey: 'nutrition.assessments',
    data: { weightKg: 70, heightCm: 170, bmi: 24.2 },
  };
  const record = (overrides = {}) => ({
    id: 'record-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    professionalId: 'nutritionist',
    specialtyId: 'nutrition',
    moduleKey: 'nutrition.assessments',
    schemaVersion: 1,
    formDefinitionId: null,
    appointmentId: null,
    recordDate: new Date('2026-10-01T10:00:00Z'),
    data: dto.data,
    notes: null,
    version: 1,
    deletedAt: null,
    ...overrides,
  });
  const customSchema = {
    sections: [
      {
        key: 'injury',
        title: 'Lesión',
        fields: [
          {
            key: 'injuryType',
            label: 'Tipo de lesión',
            type: 'select',
            required: true,
            options: [
              { value: 'DEPORTIVA', label: 'Deportiva' },
              { value: 'LABORAL', label: 'Laboral' },
            ],
          },
        ],
      },
    ],
    alerts: [{ when: "injuryType == 'LABORAL'", level: 'warning', message: 'Reportar a riesgos' }],
  };
  const db = {
    patient: { findFirst: jest.fn() },
    specialty: { findFirst: jest.fn() },
    tenantModule: { findFirst: jest.fn() },
    specialtyModule: { findFirst: jest.fn() },
    appointment: { findFirst: jest.fn() },
    formDefinition: { findFirst: jest.fn() },
    encounter: { findFirst: jest.fn() },
    formDefinitionVersion: { findFirst: jest.fn(), findMany: jest.fn() },
    treatmentSession: { findFirst: jest.fn() },
    specialtyRecord: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: { createMany: jest.fn() },
  };
  const prisma = { ...db, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const service = new SpecialtyRecordsService(
    prisma as unknown as PrismaService,
    new ClinicalAuditService(prisma as unknown as PrismaService, plain),
    plain,
  );
  const auditRows = () => db.auditLog.createMany.mock.calls.flatMap(([args]) => args.data);
  const created = () => db.specialtyRecord.create.mock.calls[0][0].data;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) => callback(db));
    db.patient.findFirst.mockResolvedValue({ id: 'patient-1' });
    db.specialty.findFirst.mockResolvedValue({ id: 'nutrition', code: 'NUTRITION' });
    db.tenantModule.findFirst.mockResolvedValue({ id: 'module' });
    db.specialtyModule.findFirst.mockResolvedValue({ id: 'specialty-module' });
    db.formDefinitionVersion.findMany.mockResolvedValue([]);
    db.specialtyRecord.create.mockImplementation(({ data }) => Promise.resolve(record(data)));
    db.specialtyRecord.update.mockImplementation(({ data }) =>
      Promise.resolve(record({ ...data, version: 2 })),
    );
  });

  describe('list', () => {
    it('lets a professional of another specialty read live records and audits each read', async () => {
      db.specialtyRecord.findMany.mockResolvedValue([record(), record({ id: 'record-2' })]);

      await service.list('tenant-1', 'patient-1', psychologist);

      expect(db.specialtyRecord.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'READ',
          entity: 'SPECIALTY_RECORD',
          entityId: 'record-1',
          patientId: 'patient-1',
          userId: 'psy',
        }),
        expect.objectContaining({ action: 'READ', entityId: 'record-2', userId: 'psy' }),
      ]);
    });

    it('does not list records of a patient outside the tenant', async () => {
      db.patient.findFirst.mockResolvedValue(null);

      await expect(service.list('tenant-1', 'foreign', psychologist)).rejects.toMatchObject({
        status: 404,
      });
      expect(db.specialtyRecord.findMany).not.toHaveBeenCalled();
    });

    it('returns each record with the alerts of the definition it was written under', async () => {
      db.specialtyRecord.findMany.mockResolvedValue([
        record({
          id: 'allergy',
          moduleKey: 'general.allergies',
          data: {
            category: 'ALIMENTO',
            allergen: 'Maní',
            reaction: 'Anafilaxia',
            severity: 'GRAVE',
          },
        }),
        record({
          id: 'custom',
          moduleKey: 'custom.form-1',
          formDefinitionId: 'form-1',
          schemaVersion: 2,
          data: { injuryType: 'LABORAL' },
        }),
        record({ id: 'legacy' }),
      ]);
      db.formDefinitionVersion.findMany.mockResolvedValue([
        {
          formDefinitionId: 'form-1',
          version: 2,
          schema: customSchema,
          formDefinition: { name: 'Ficha de lesión' },
        },
      ]);

      const records = await service.list('tenant-1', 'patient-1', psychologist);

      expect(records.map(({ id, alerts }) => [id, alerts])).toEqual([
        ['allergy', [{ level: 'critical', message: 'Alergia grave registrada.' }]],
        ['custom', [{ level: 'warning', message: 'Reportar a riesgos' }]],
        ['legacy', []],
      ]);
      expect(db.formDefinitionVersion.findMany.mock.calls[0][0].where).toEqual({
        formDefinitionId: { in: ['form-1'] },
        formDefinition: { tenantId: 'tenant-1' },
      });
    });
  });

  describe('findOne', () => {
    it('returns the record with its alerts and audits the read', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(
        record({
          moduleKey: 'general.vital-signs',
          data: { oxygenSaturation: 85 },
          verificationCode: '0123456789ABCDEF',
        }),
      );

      const found = await service.findOne('tenant-1', 'patient-1', 'record-1', psychologist);

      expect(db.specialtyRecord.findFirst.mock.calls[0][0].where).toEqual({
        id: 'record-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
      expect(found.alerts).toEqual([
        { level: 'critical', message: 'Saturación de oxígeno menor al 90 %.' },
      ]);
      expect(auditRows()).toEqual([
        expect.objectContaining({ action: 'READ', entityId: 'record-1', userId: 'psy' }),
      ]);
    });

    it('gives a record from before the codes its verification code, without touching its date', async () => {
      const updatedAt = new Date('2026-09-01T10:00:00.000Z');
      db.specialtyRecord.findFirst.mockResolvedValue(record({ verificationCode: null, updatedAt }));
      db.specialtyRecord.updateMany.mockResolvedValue({ count: 1 });

      const found = await service.findOne('tenant-1', 'patient-1', 'record-1', psychologist);

      expect(found.verificationCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
      expect(db.specialtyRecord.updateMany).toHaveBeenCalledWith({
        where: { id: 'record-1', verificationCode: null },
        data: { verificationCode: found.verificationCode, updatedAt },
      });
    });

    it('keeps the code another request assigned first, and the one a record already has', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(record({ verificationCode: null }));
      db.specialtyRecord.updateMany.mockResolvedValue({ count: 0 });
      db.specialtyRecord.findUnique.mockResolvedValue({ verificationCode: 'ABCDEFGHJKMNPQRS' });
      await expect(
        service.findOne('tenant-1', 'patient-1', 'record-1', psychologist),
      ).resolves.toMatchObject({ verificationCode: 'ABCDEFGHJKMNPQRS' });

      db.specialtyRecord.updateMany.mockClear();
      db.specialtyRecord.findFirst.mockResolvedValue(
        record({ verificationCode: '0123456789ABCDEF' }),
      );
      await expect(
        service.findOne('tenant-1', 'patient-1', 'record-1', psychologist),
      ).resolves.toMatchObject({ verificationCode: '0123456789ABCDEF' });
      expect(db.specialtyRecord.updateMany).not.toHaveBeenCalled();
    });

    it('does not find a removed record or one of another patient', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.findOne('tenant-1', 'patient-1', 'gone', psychologist),
      ).rejects.toMatchObject({ status: 404, response: { code: 'CLINICAL_RECORD_NOT_FOUND' } });
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });
  });

  describe('alerts', () => {
    const allergy = (id: string, severity: string, recordDate: string) =>
      record({
        id,
        moduleKey: 'general.allergies',
        recordDate: new Date(recordDate),
        data: { category: 'ALIMENTO', allergen: id, reaction: 'Urticaria', severity },
      });
    const vitals = (id: string, oxygenSaturation: number, recordDate: string) =>
      record({
        id,
        moduleKey: 'general.vital-signs',
        recordDate: new Date(recordDate),
        data: { oxygenSaturation },
      });

    it('reports every allergy but only the latest record of other modules, and audits what it discloses', async () => {
      db.specialtyRecord.findMany.mockResolvedValue([
        vitals('vitals-new', 97, '2026-10-03T10:00:00Z'),
        allergy('allergy-new', 'LEVE', '2026-10-02T10:00:00Z'),
        vitals('vitals-old', 85, '2026-10-01T10:00:00Z'),
        allergy('allergy-old', 'GRAVE', '2026-09-01T10:00:00Z'),
      ]);

      const alerts = await service.alerts('tenant-1', 'patient-1', psychologist);

      expect(alerts).toEqual([
        {
          level: 'critical',
          message: 'Alergia grave registrada.',
          recordId: 'allergy-old',
          moduleKey: 'general.allergies',
          moduleName: 'Alergias',
          recordDate: new Date('2026-09-01T10:00:00Z'),
        },
      ]);
      expect(db.specialtyRecord.findMany.mock.calls[0][0]).toMatchObject({
        where: { tenantId: 'tenant-1', patientId: 'patient-1', deletedAt: null },
        orderBy: { recordDate: 'desc' },
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({ action: 'READ', entityId: 'allergy-old', userId: 'psy' }),
      ]);
    });

    it('audits nothing when no record raises an alert', async () => {
      db.specialtyRecord.findMany.mockResolvedValue([vitals('ok', 98, '2026-10-03T10:00:00Z')]);

      expect(await service.alerts('tenant-1', 'patient-1', psychologist)).toEqual([]);
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('creates the record under the author and audits it with its content', async () => {
      await service.create('tenant-1', 'patient-1', nutritionist, dto);

      expect(created()).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'nutritionist',
        specialtyId: 'nutrition',
        // A request without a version is a pre-definition client: it writes the legacy format.
        schemaVersion: 1,
        formDefinitionId: null,
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          entity: 'SPECIALTY_RECORD',
          entityId: 'record-1',
          patientId: 'patient-1',
          userId: 'nutritionist',
          changes: {
            before: null,
            after: expect.objectContaining({ data: dto.data, version: 1, schemaVersion: 1 }),
          },
        }),
      ]);
    });

    it('refuses a record under a specialty that is not the author’s own', async () => {
      await expect(
        service.create('tenant-1', 'patient-1', psychologist, dto),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'CLINICAL_RECORD_FORBIDDEN' },
      });
      expect(db.specialtyRecord.create).not.toHaveBeenCalled();
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });

    it('validates against the named version and stores the normalized, computed data', async () => {
      const result = await service.create('tenant-1', 'patient-1', nutritionist, {
        moduleKey: 'nutrition.assessments',
        schemaVersion: 2,
        data: { weightKg: '70', heightCm: 170, bmi: 99 },
      });

      expect(created()).toMatchObject({
        schemaVersion: 2,
        data: { weightKg: 70, heightCm: 170, bmi: 24.22 },
      });
      expect(result.alerts).toEqual([]);
    });

    it('rejects data that does not follow the definition without writing anything', async () => {
      await expect(
        service.create('tenant-1', 'patient-1', nutritionist, {
          moduleKey: 'nutrition.assessments',
          schemaVersion: 2,
          data: { weightKg: 900, heightCm: 170 },
        }),
      ).rejects.toMatchObject({
        status: 422,
        response: {
          code: 'CLINICAL_RECORD_INVALID',
          details: [{ field: 'weightKg', message: 'Debe ser menor o igual a 500' }],
        },
      });
      expect(db.specialtyRecord.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown module and a version that is no longer current', async () => {
      await expect(
        service.create('tenant-1', 'patient-1', nutritionist, {
          moduleKey: 'nutrition.x',
          data: {},
        }),
      ).rejects.toMatchObject({ status: 400, response: { code: 'CLINICAL_MODULE_UNKNOWN' } });
      await expect(
        service.create('tenant-1', 'patient-1', nutritionist, {
          moduleKey: 'nutrition.assessments',
          schemaVersion: 7,
          data: {},
        }),
      ).rejects.toMatchObject({ status: 400, response: { code: 'CLINICAL_MODULE_UNKNOWN' } });
      expect(db.specialtyRecord.create).not.toHaveBeenCalled();
    });

    it('rejects a specialty code that does not own the module', async () => {
      await expect(
        service.create('tenant-1', 'patient-1', nutritionist, {
          ...dto,
          specialtyCode: 'DENTISTRY',
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(db.specialty.findFirst).not.toHaveBeenCalled();
    });

    it('refuses a specialty module the clinic has disabled', async () => {
      db.tenantModule.findFirst.mockResolvedValue(null);

      await expect(
        service.create('tenant-1', 'patient-1', nutritionist, dto),
      ).rejects.toMatchObject({ status: 403 });
      expect(db.tenantModule.findFirst.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
        moduleKey: 'nutrition.assessments',
        enabled: true,
      });
    });

    it('lets any professional write a general module under their own specialty', async () => {
      const result = await service.create('tenant-1', 'patient-1', psychologist, {
        moduleKey: 'general.vital-signs',
        data: { oxygenSaturation: 88 },
      });

      expect(created()).toMatchObject({
        professionalId: 'psy',
        specialtyId: 'psychology',
        moduleKey: 'general.vital-signs',
        schemaVersion: 1,
      });
      expect(result.alerts).toEqual([
        { level: 'critical', message: 'Saturación de oxígeno menor al 90 %.' },
      ]);
      // General modules are not tied to the specialty catalog of the clinic.
      expect(db.tenantModule.findFirst).not.toHaveBeenCalled();
      expect(db.specialtyModule.findFirst).not.toHaveBeenCalled();
    });

    describe('inside an encounter', () => {
      const inEncounter = { ...dto, encounterId: 'encounter-1' };

      it('links the record to an open encounter of the author', async () => {
        db.encounter.findFirst.mockResolvedValue({
          professionalId: 'nutritionist',
          status: 'OPEN',
        });

        await service.create('tenant-1', 'patient-1', nutritionist, inEncounter);

        expect(db.encounter.findFirst.mock.calls[0][0].where).toEqual({
          id: 'encounter-1',
          tenantId: 'tenant-1',
          patientId: 'patient-1',
          deletedAt: null,
        });
        expect(created()).toMatchObject({ encounterId: 'encounter-1' });
      });

      it.each([
        ['that does not exist for the patient', null, 404],
        ['of another professional', { professionalId: 'someone', status: 'OPEN' }, 403],
        ['that is closed', { professionalId: 'nutritionist', status: 'CLOSED' }, 409],
      ])('refuses an encounter %s', async (_label, found, status) => {
        db.encounter.findFirst.mockResolvedValue(found);

        await expect(
          service.create('tenant-1', 'patient-1', nutritionist, inEncounter),
        ).rejects.toMatchObject({ status });
        expect(db.specialtyRecord.create).not.toHaveBeenCalled();
      });
    });

    describe('prescriptions', () => {
      const prescription = {
        moduleKey: 'general.prescriptions',
        data: {
          items: [
            {
              medication: 'Ibuprofeno',
              dose: '400 mg',
              frequency: 'Cada 8 horas',
              route: 'ORAL',
              duration: '3 días',
            },
          ],
        },
      };

      it('are refused to a specialty that does not prescribe', async () => {
        db.specialty.findFirst.mockResolvedValue({ code: 'PSYCHOLOGY' });

        await expect(
          service.create('tenant-1', 'patient-1', psychologist, prescription),
        ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });
        expect(db.specialty.findFirst.mock.calls[0][0].where).toEqual({ id: 'psychology' });
        expect(db.specialtyRecord.create).not.toHaveBeenCalled();
      });

      it('are accepted from a prescribing specialty', async () => {
        db.specialty.findFirst.mockResolvedValue({ code: 'DENTISTRY' });

        await service.create('tenant-1', 'patient-1', dentist, prescription);

        expect(created()).toMatchObject({ professionalId: 'dentist', specialtyId: 'dentistry' });
      });
    });

    describe('tenant forms', () => {
      const answer = {
        moduleKey: 'custom.form-1',
        schemaVersion: 2,
        data: { injuryType: 'LABORAL' },
      };
      const form = (overrides = {}) => ({
        id: 'form-1',
        name: 'Ficha de lesión',
        isActive: true,
        specialtyId: null,
        currentVersion: 2,
        ...overrides,
      });

      beforeEach(() => {
        db.formDefinition.findFirst.mockResolvedValue(form());
        db.formDefinitionVersion.findFirst.mockResolvedValue({ version: 2, schema: customSchema });
      });

      it('stores the answer with the form and the version it was filled with', async () => {
        const result = await service.create('tenant-1', 'patient-1', psychologist, answer);

        expect(db.formDefinition.findFirst.mock.calls[0][0].where).toEqual({
          id: 'form-1',
          tenantId: 'tenant-1',
        });
        expect(db.formDefinitionVersion.findFirst.mock.calls[0][0].where).toEqual({
          formDefinitionId: 'form-1',
          version: 2,
        });
        expect(created()).toMatchObject({
          moduleKey: 'custom.form-1',
          formDefinitionId: 'form-1',
          schemaVersion: 2,
          specialtyId: 'psychology',
          data: { injuryType: 'LABORAL' },
        });
        expect(result.alerts).toEqual([{ level: 'warning', message: 'Reportar a riesgos' }]);
      });

      it('validates the answer against the form schema', async () => {
        await expect(
          service.create('tenant-1', 'patient-1', psychologist, {
            ...answer,
            data: { injuryType: 'OTRA' },
          }),
        ).rejects.toMatchObject({ status: 422, response: { code: 'CLINICAL_RECORD_INVALID' } });
      });

      it('refuses an answer written against a version that is no longer current', async () => {
        await expect(
          service.create('tenant-1', 'patient-1', psychologist, { ...answer, schemaVersion: 1 }),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'CLINICAL_MODULE_VERSION_OUTDATED' },
        });
      });

      it('refuses a form of another tenant, an inactive form and a form of another specialty', async () => {
        db.formDefinition.findFirst.mockResolvedValueOnce(null);
        await expect(
          service.create('tenant-1', 'patient-1', psychologist, answer),
        ).rejects.toMatchObject({ status: 400, response: { code: 'CLINICAL_MODULE_UNKNOWN' } });

        db.formDefinition.findFirst.mockResolvedValueOnce(form({ isActive: false }));
        await expect(
          service.create('tenant-1', 'patient-1', psychologist, answer),
        ).rejects.toMatchObject({ status: 403 });

        db.formDefinition.findFirst.mockResolvedValueOnce(form({ specialtyId: 'nutrition' }));
        await expect(
          service.create('tenant-1', 'patient-1', psychologist, answer),
        ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });

        expect(db.specialtyRecord.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('writePinnedForm', () => {
    // Version 2 asks for a select; version 3 (the current one) asks for free text instead.
    const v2Schema = customSchema;
    const v3Schema = {
      sections: [
        {
          key: 'injury',
          title: 'Lesión',
          fields: [{ key: 'injuryText', label: 'Lesión', type: 'text', required: true }],
        },
      ],
    };
    const input = (overrides = {}) => ({
      encounterId: 'encounter-1',
      formDefinitionId: 'form-1',
      formVersion: 2,
      data: { injuryType: 'LABORAL' },
      ...overrides,
    });
    const write = (overrides = {}, actor = psychologist) =>
      service.writePinnedForm(db as never, 'tenant-1', 'patient-1', actor, input(overrides));

    beforeEach(() => {
      db.formDefinition.findFirst.mockResolvedValue({ id: 'form-1', currentVersion: 3 });
      db.formDefinitionVersion.findFirst.mockImplementation(({ where }) =>
        Promise.resolve(
          where.version === 2
            ? { version: 2, schema: v2Schema, formDefinition: { name: 'Ficha de lesión' } }
            : where.version === 3
              ? { version: 3, schema: v3Schema, formDefinition: { name: 'Ficha de lesión' } }
              : null,
        ),
      );
      db.encounter.findFirst.mockResolvedValue({ professionalId: 'psy', status: 'OPEN' });
    });

    it('validates against the pinned version, not the current one, and stores it in the encounter', async () => {
      const written = await write();

      expect(db.formDefinitionVersion.findFirst.mock.calls[0][0].where).toEqual({
        formDefinitionId: 'form-1',
        version: 2,
        formDefinition: { tenantId: 'tenant-1' },
      });
      expect(created()).toMatchObject({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        professionalId: 'psy',
        specialtyId: 'psychology',
        moduleKey: 'custom.form-1',
        formDefinitionId: 'form-1',
        schemaVersion: 2,
        encounterId: 'encounter-1',
        data: { injuryType: 'LABORAL' },
      });
      expect(written).toEqual({ id: 'record-1' });
      expect(auditRows()).toEqual([
        expect.objectContaining({ action: 'CREATE', entity: 'SPECIALTY_RECORD' }),
      ]);
    });

    it('rejects data that only the current version accepts', async () => {
      await expect(write({ data: { injuryText: 'Esguince' } })).rejects.toMatchObject({
        status: 422,
        response: { code: 'CLINICAL_RECORD_INVALID' },
      });
      expect(db.specialtyRecord.create).not.toHaveBeenCalled();
    });

    it('rejects a pinned version that does not exist in the tenant', async () => {
      await expect(write({ formVersion: 7 })).rejects.toMatchObject({
        status: 400,
        response: { code: 'CLINICAL_MODULE_UNKNOWN' },
      });
    });

    it('corrects the record it is given: bumps its version and audits both states', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(
        record({
          professionalId: 'psy',
          moduleKey: 'custom.form-1',
          formDefinitionId: 'form-1',
          schemaVersion: 2,
          data: { injuryType: 'DEPORTIVA' },
        }),
      );

      const written = await write({ recordId: 'record-1' });

      expect(db.specialtyRecord.create).not.toHaveBeenCalled();
      expect(db.specialtyRecord.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'record-1' },
        data: { data: { injuryType: 'LABORAL' }, version: { increment: 1 } },
      });
      expect(written).toEqual({ id: 'record-1' });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          entity: 'SPECIALTY_RECORD',
          entityId: 'record-1',
          changes: {
            before: expect.objectContaining({ version: 1, data: { injuryType: 'DEPORTIVA' } }),
            after: expect.objectContaining({ version: 2, data: { injuryType: 'LABORAL' } }),
          },
        }),
      ]);
    });

    it('lets only the author correct the record', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(record({ professionalId: 'psy' }));

      await expect(write({ recordId: 'record-1' }, dentist)).rejects.toMatchObject({
        status: 403,
        response: { code: 'CLINICAL_RECORD_FORBIDDEN' },
      });
      expect(db.specialtyRecord.update).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    const current = record({
      schemaVersion: 2,
      data: { weightKg: 96.5, heightCm: 165, bmi: 35.45 },
      notes: 'Medición inicial.',
    });

    beforeEach(() => db.specialtyRecord.findFirst.mockResolvedValue(current));

    it('corrects the data under the version it was written with and keeps both states in the audit log', async () => {
      const result = await service.update('tenant-1', 'patient-1', 'record-1', nutritionist, {
        data: { weightKg: 69.5, heightCm: 165 },
        changeReason: 'Peso digitado con error.',
      });

      expect(db.specialtyRecord.findFirst.mock.calls[0][0].where).toEqual({
        id: 'record-1',
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        deletedAt: null,
      });
      expect(db.specialtyRecord.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'record-1' },
        data: { data: { weightKg: 69.5, heightCm: 165, bmi: 25.53 }, version: { increment: 1 } },
      });
      expect(result.version).toBe(2);
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          entity: 'SPECIALTY_RECORD',
          entityId: 'record-1',
          userId: 'nutritionist',
          reason: 'Peso digitado con error.',
          changes: {
            before: expect.objectContaining({ version: 1, data: current.data }),
            after: expect.objectContaining({
              version: 2,
              data: { weightKg: 69.5, heightCm: 165, bmi: 25.53 },
            }),
          },
        }),
      ]);
    });

    it('clears the notes without touching the data', async () => {
      await service.update('tenant-1', 'patient-1', 'record-1', nutritionist, {
        notes: '  ',
        changeReason: 'Nota de otro paciente.',
      });

      const { data } = db.specialtyRecord.update.mock.calls[0][0];
      expect(data.notes).toBeNull();
      expect(data).not.toHaveProperty('data');
    });

    it('rejects a correction that breaks the definition', async () => {
      await expect(
        service.update('tenant-1', 'patient-1', 'record-1', nutritionist, {
          data: { weightKg: 69.5 },
          changeReason: 'x',
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(db.specialtyRecord.update).not.toHaveBeenCalled();
    });

    it('lets only the author correct a record', async () => {
      await expect(
        service.update('tenant-1', 'patient-1', 'record-1', psychologist, {
          notes: 'x',
          changeReason: 'x',
        }),
      ).rejects.toMatchObject({ status: 403, response: { code: 'CLINICAL_RECORD_FORBIDDEN' } });
      expect(db.specialtyRecord.update).not.toHaveBeenCalled();
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });

    it.each(['IN_PROGRESS', 'CLINICAL_COMPLETE', 'CANCELLED'])(
      'refuses to change the form of a treatment session that is %s',
      async (status) => {
        db.treatmentSession.findFirst.mockResolvedValue({ id: 'session-1', status });

        await expect(
          service.update('tenant-1', 'patient-1', 'record-1', nutritionist, {
            notes: 'x',
            changeReason: 'x',
          }),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: 'TREATMENT_SESSION_INVALID_TRANSITION', status },
        });
        expect(db.treatmentSession.findFirst.mock.calls[0][0].where).toEqual({
          tenantId: 'tenant-1',
          formRecordId: 'record-1',
        });
        expect(db.specialtyRecord.update).not.toHaveBeenCalled();
        expect(db.auditLog.createMany).not.toHaveBeenCalled();
      },
    );

    it('still corrects the form of a treatment session that has not started', async () => {
      db.treatmentSession.findFirst.mockResolvedValue({ id: 'session-1', status: 'CONSENTED' });

      await service.update('tenant-1', 'patient-1', 'record-1', nutritionist, {
        notes: 'x',
        changeReason: 'x',
      });

      expect(db.specialtyRecord.update).toHaveBeenCalled();
    });

    it('does not find a removed record or one of another patient', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(null);

      await expect(
        service.update('tenant-1', 'patient-1', 'record-1', nutritionist, {
          notes: 'x',
          changeReason: 'x',
        }),
      ).rejects.toMatchObject({ status: 404, response: { code: 'CLINICAL_RECORD_NOT_FOUND' } });
    });
  });

  describe('delete', () => {
    it('keeps the row, marks who removed it and why, and audits the removal', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(record());

      await service.delete('tenant-1', 'patient-1', 'record-1', nutritionist, {
        reason: 'Paciente equivocado.',
      });

      expect(db.specialtyRecord.update.mock.calls[0][0]).toEqual({
        where: { id: 'record-1' },
        data: {
          deletedAt: expect.any(Date),
          deletedById: 'nutritionist',
          deletionReason: 'Paciente equivocado.',
        },
      });
      expect(auditRows()).toEqual([
        expect.objectContaining({
          action: 'DELETE',
          entityId: 'record-1',
          reason: 'Paciente equivocado.',
          changes: { before: expect.objectContaining({ data: dto.data }), after: null },
        }),
      ]);
    });

    it('refuses to remove the form of a treatment session that has started', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(record());
      db.treatmentSession.findFirst.mockResolvedValue({ id: 'session-1', status: 'IN_PROGRESS' });

      await expect(
        service.delete('tenant-1', 'patient-1', 'record-1', nutritionist, { reason: 'x' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'TREATMENT_SESSION_INVALID_TRANSITION', status: 'IN_PROGRESS' },
      });
      expect(db.specialtyRecord.update).not.toHaveBeenCalled();
      expect(db.auditLog.createMany).not.toHaveBeenCalled();
    });

    it('lets only the author remove a record', async () => {
      db.specialtyRecord.findFirst.mockResolvedValue(record());

      await expect(
        service.delete('tenant-1', 'patient-1', 'record-1', psychologist, { reason: 'x' }),
      ).rejects.toMatchObject({ status: 403 });
      expect(db.specialtyRecord.update).not.toHaveBeenCalled();
    });
  });
});
