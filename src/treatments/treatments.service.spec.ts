import { ConsentTemplatesService } from '../consents/consent-templates.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_REQUIREMENTS } from './treatment-requirements';
import { TreatmentsService, TreatmentVersionInput } from './treatments.service';

describe('TreatmentsService', () => {
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    treatment: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    treatmentVersion: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    formDefinitionVersion: { findFirst: jest.fn() },
    consentTemplateVersion: { findFirst: jest.fn() },
    tenantSpecialty: { findUnique: jest.fn() },
  };
  const db = prisma as unknown as PrismaService;
  const service = new TreatmentsService(db, new ConsentTemplatesService(db));

  const input = (extra: Partial<TreatmentVersionInput> = {}): TreatmentVersionInput => ({
    price: 120.5,
    taxRatePercent: 12,
    durationMinutes: 45,
    ...extra,
  });

  const versionRow = (version: number, extra: Record<string, unknown> = {}) => ({
    id: `version-${version}`,
    tenantId: 'tenant-1',
    treatmentId: 'treatment-1',
    version,
    price: '120.50',
    taxRatePercent: '12.00',
    durationMinutes: 45,
    formDefinitionId: null,
    formVersion: null,
    consentTemplateVersionId: null,
    requirements: DEFAULT_REQUIREMENTS,
    createdById: 'user-1',
    ...extra,
  });
  const treatmentRow = (versions: unknown[], extra: Record<string, unknown> = {}) => ({
    id: 'treatment-1',
    tenantId: 'tenant-1',
    name: 'Botox',
    category: null,
    specialtyId: null,
    isActive: true,
    currentVersion: versions.length,
    versions,
    ...extra,
  });

  async function failure(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error as { getStatus(): number; getResponse(): Record<string, unknown> };
    }
    throw new Error('expected the call to fail');
  }

  async function invalidIssues(promise: Promise<unknown>): Promise<string[]> {
    const error = await failure(promise);
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_REQUIREMENTS_INVALID' });
    return error.getResponse().issues as string[];
  }

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.treatment.create.mockImplementation(({ data }) =>
      treatmentRow([versionRow(1, data.versions.create)], { currentVersion: 1 }),
    );
    prisma.treatment.updateMany.mockResolvedValue({ count: 1 });
    prisma.treatmentVersion.create.mockImplementation(({ data }) => versionRow(data.version, data));
  });

  describe('create', () => {
    it('stores version 1 as the current version, with its author, and returns plain numbers', async () => {
      const result = await service.create('tenant-1', 'user-1', {
        name: ' Botox ',
        version: input({ requirements: { photos: { minimumBefore: 2 } } }),
      });

      expect(prisma.applyRlsContext).toHaveBeenCalledWith(prisma);
      const { data } = prisma.treatment.create.mock.calls[0][0];
      expect(data).toMatchObject({ tenantId: 'tenant-1', name: 'Botox', currentVersion: 1 });
      expect(data.versions.create).toMatchObject({
        tenantId: 'tenant-1',
        version: 1,
        price: '120.50',
        taxRatePercent: '12.00',
        durationMinutes: 45,
        createdById: 'user-1',
        requirements: { ...DEFAULT_REQUIREMENTS, photos: { minimumBefore: 2, minimumAfter: 0 } },
      });
      expect(result.versions[0]).toMatchObject({ version: 1, price: 120.5, taxRatePercent: 12 });
      expect(typeof result.versions[0].price).toBe('number');
    });

    it('maps a taken name to 409 TREATMENT_NAME_TAKEN', async () => {
      prisma.treatment.create.mockRejectedValue({ code: 'P2002' });

      const error = await failure(
        service.create('tenant-1', 'user-1', { name: 'Botox', version: input() }),
      );

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_NAME_TAKEN' });
    });

    it('rejects a specialty the tenant does not have', async () => {
      prisma.tenantSpecialty.findUnique.mockResolvedValue(null);

      const issues = await invalidIssues(
        service.create('tenant-1', 'user-1', {
          name: 'Botox',
          specialtyId: 'other',
          version: input(),
        }),
      );

      expect(issues).toEqual(['specialtyId debe ser una especialidad de la clínica.']);
      expect(prisma.tenantSpecialty.findUnique.mock.calls[0][0].where).toEqual({
        tenantId_specialtyId: { tenantId: 'tenant-1', specialtyId: 'other' },
      });
      expect(prisma.treatment.create).not.toHaveBeenCalled();
    });

    it('accepts a form and a published consent that exist in the tenant', async () => {
      prisma.formDefinitionVersion.findFirst.mockResolvedValue({
        formDefinition: { isActive: true },
      });
      prisma.consentTemplateVersion.findFirst.mockResolvedValue({
        id: 'cv-1',
        status: 'PUBLISHED',
      });

      await service.create('tenant-1', 'user-1', {
        name: 'Botox',
        version: input({
          formDefinitionId: 'form-1',
          formVersion: 3,
          consentTemplateVersionId: 'cv-1',
          requirements: { medicalForm: { required: true }, informedConsent: { required: true } },
        }),
      });

      expect(prisma.formDefinitionVersion.findFirst.mock.calls[0][0].where).toEqual({
        formDefinitionId: 'form-1',
        version: 3,
        formDefinition: { tenantId: 'tenant-1' },
      });
      expect(prisma.treatment.create).toHaveBeenCalled();
    });
  });

  describe('version validation', () => {
    const create = (version: TreatmentVersionInput) =>
      service.create('tenant-1', 'user-1', { name: 'Botox', version });

    it('requires a consent version when the consent is required', async () => {
      const issues = await invalidIssues(
        create(input({ requirements: { informedConsent: { required: true } } })),
      );

      expect(issues).toEqual(['informedConsent.required exige consentTemplateVersionId.']);
    });

    it('rejects a retired consent version', async () => {
      prisma.consentTemplateVersion.findFirst.mockResolvedValue({ id: 'cv-1', status: 'RETIRED' });

      const issues = await invalidIssues(
        create(
          input({
            consentTemplateVersionId: 'cv-1',
            requirements: { informedConsent: { required: true } },
          }),
        ),
      );

      expect(issues).toEqual([
        'consentTemplateVersionId debe ser una versión publicada de la clínica.',
      ]);
    });

    it('rejects a consent version when the consent is not required', async () => {
      const issues = await invalidIssues(create(input({ consentTemplateVersionId: 'cv-1' })));

      expect(issues).toEqual([
        'consentTemplateVersionId solo se admite con informedConsent.required.',
      ]);
      expect(prisma.consentTemplateVersion.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a form version that does not exist in the tenant', async () => {
      prisma.formDefinitionVersion.findFirst.mockResolvedValue(null);

      const issues = await invalidIssues(
        create(
          input({
            formDefinitionId: 'form-1',
            formVersion: 99,
            requirements: { medicalForm: { required: true } },
          }),
        ),
      );

      expect(issues).toEqual([
        'formDefinitionId y formVersion deben ser una versión de ficha de la clínica.',
      ]);
    });

    it('rejects an inactive form', async () => {
      prisma.formDefinitionVersion.findFirst.mockResolvedValue({
        formDefinition: { isActive: false },
      });

      const issues = await invalidIssues(
        create(
          input({
            formDefinitionId: 'form-1',
            formVersion: 1,
            requirements: { medicalForm: { required: true } },
          }),
        ),
      );

      expect(issues).toEqual(['La ficha médica debe estar activa.']);
    });

    it('requires the form when the medical form is required, and the pair together', async () => {
      expect(
        await invalidIssues(create(input({ requirements: { medicalForm: { required: true } } }))),
      ).toEqual(['medicalForm.required exige formDefinitionId y formVersion.']);
      expect(await invalidIssues(create(input({ formDefinitionId: 'form-1' })))).toEqual([
        'formDefinitionId y formVersion deben indicarse juntos.',
      ]);
      expect(await invalidIssues(create(input({ formVersion: 2 })))).toEqual([
        'formDefinitionId y formVersion deben indicarse juntos.',
      ]);
    });

    it.each([
      [{ price: 10.005 }, 'price debe ser un monto entre 0 y 999999.99 con dos decimales.'],
      [{ price: -1 }, 'price debe ser un monto entre 0 y 999999.99 con dos decimales.'],
      [{ price: 1000000 }, 'price debe ser un monto entre 0 y 999999.99 con dos decimales.'],
      [
        { taxRatePercent: 100.5 },
        'taxRatePercent debe ser un porcentaje entre 0 y 100 con dos decimales.',
      ],
      [{ durationMinutes: 4 }, 'durationMinutes debe ser un entero entre 5 y 1440.'],
      [{ durationMinutes: 30.5 }, 'durationMinutes debe ser un entero entre 5 y 1440.'],
    ])('rejects %j', async (extra, issue) => {
      expect(await invalidIssues(create(input(extra)))).toEqual([issue]);
    });

    it('accepts the limits of every range', async () => {
      await create(input({ price: 999999.99, taxRatePercent: 100, durationMinutes: 1440 }));
      await create(input({ price: 0, taxRatePercent: 0, durationMinutes: 5 }));

      expect(prisma.treatment.create).toHaveBeenCalledTimes(2);
    });

    it('collects every issue and throws once, merging the requirements issues', async () => {
      const issues = await invalidIssues(
        create(
          input({
            price: 10.005,
            durationMinutes: 1,
            formVersion: 2,
            requirements: { photos: { minimumBefore: 99 }, informedConsent: { required: true } },
          }),
        ),
      );

      expect(issues).toEqual([
        'price debe ser un monto entre 0 y 999999.99 con dos decimales.',
        'durationMinutes debe ser un entero entre 5 y 1440.',
        'photos.minimumBefore debe ser un entero entre 0 y 20',
        'formDefinitionId y formVersion deben indicarse juntos.',
        'informedConsent.required exige consentTemplateVersionId.',
      ]);
      expect(prisma.treatment.create).not.toHaveBeenCalled();
    });
  });

  describe('addVersion', () => {
    beforeEach(() => {
      prisma.treatment.findFirst.mockResolvedValue(treatmentRow([versionRow(1)]));
    });

    it('stores version 2, bumps currentVersion and leaves version 1 unchanged', async () => {
      await service.addVersion('tenant-1', 'user-2', 'treatment-1', input({ price: 200 }));

      expect(prisma.treatmentVersion.create).toHaveBeenCalledTimes(1);
      expect(prisma.treatmentVersion.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        treatmentId: 'treatment-1',
        version: 2,
        price: '200.00',
        createdById: 'user-2',
      });
      // The bump only succeeds while nobody else moved the number since it was read.
      expect(prisma.treatment.updateMany).toHaveBeenCalledWith({
        where: { id: 'treatment-1', tenantId: 'tenant-1', currentVersion: 1 },
        data: { currentVersion: 2 },
      });
      expect(prisma.treatmentVersion.update).not.toHaveBeenCalled();
      expect(prisma.treatmentVersion.updateMany).not.toHaveBeenCalled();
    });

    it('answers 409 TREATMENT_VERSION_CONFLICT when a concurrent version took the number', async () => {
      prisma.treatment.updateMany.mockResolvedValue({ count: 0 });

      const error = await failure(service.addVersion('tenant-1', 'user-2', 'treatment-1', input()));

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_VERSION_CONFLICT' });
      expect(prisma.treatmentVersion.create).not.toHaveBeenCalled();
    });

    it('answers 409 TREATMENT_VERSION_CONFLICT on a unique violation of the version number', async () => {
      prisma.treatmentVersion.create.mockRejectedValue({ code: 'P2002' });

      const error = await failure(service.addVersion('tenant-1', 'user-2', 'treatment-1', input()));

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({
        code: 'TREATMENT_VERSION_CONFLICT',
        message: expect.stringContaining('Vuelve a intentarlo'),
      });
    });

    it('validates the version before storing it', async () => {
      const issues = await invalidIssues(
        service.addVersion('tenant-1', 'user-2', 'treatment-1', input({ price: 10.005 })),
      );

      expect(issues).toHaveLength(1);
      expect(prisma.treatment.updateMany).not.toHaveBeenCalled();
    });

    it('does not find a treatment of another tenant', async () => {
      prisma.treatment.findFirst.mockResolvedValue(null);

      const error = await failure(service.addVersion('tenant-2', 'user-2', 'treatment-1', input()));

      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_NOT_FOUND' });
      expect(prisma.treatment.findFirst.mock.calls[0][0].where).toEqual({
        id: 'treatment-1',
        tenantId: 'tenant-2',
      });
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.treatment.findFirst.mockResolvedValue(treatmentRow([versionRow(1)]));
      prisma.treatment.update.mockResolvedValue({});
    });

    it('changes only the fields it is given', async () => {
      await service.update('tenant-1', 'treatment-1', { name: ' Toxina ', isActive: false });

      expect(prisma.treatment.update).toHaveBeenCalledWith({
        where: { id: 'treatment-1' },
        data: { name: 'Toxina', isActive: false },
      });
      expect(prisma.tenantSpecialty.findUnique).not.toHaveBeenCalled();
    });

    it('clears the specialty with null without looking it up', async () => {
      await service.update('tenant-1', 'treatment-1', { specialtyId: null });

      expect(prisma.treatment.update.mock.calls[0][0].data).toEqual({ specialtyId: null });
      expect(prisma.tenantSpecialty.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a specialty the tenant does not have', async () => {
      prisma.tenantSpecialty.findUnique.mockResolvedValue(null);

      await invalidIssues(service.update('tenant-1', 'treatment-1', { specialtyId: 'other' }));

      expect(prisma.treatment.update).not.toHaveBeenCalled();
    });

    it('maps a taken name to 409 TREATMENT_NAME_TAKEN', async () => {
      prisma.treatment.update.mockRejectedValue({ code: 'P2002' });

      const error = await failure(service.update('tenant-1', 'treatment-1', { name: 'Botox' }));

      expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_NAME_TAKEN' });
    });
  });

  describe('reads', () => {
    it('lists the tenant treatments with the current version only, numbers and requirements parsed', async () => {
      prisma.treatment.findMany.mockResolvedValue([
        treatmentRow([versionRow(2)], { currentVersion: 2 }),
      ]);

      const [treatment] = await service.list('tenant-1', { active: true });

      const args = prisma.treatment.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ tenantId: 'tenant-1', isActive: true });
      expect(args.include.versions).toMatchObject({ orderBy: { version: 'desc' }, take: 1 });
      expect(treatment.current).toMatchObject({ version: 2, price: 120.5, taxRatePercent: 12 });
      expect(treatment.current.requirements).toEqual(DEFAULT_REQUIREMENTS);
      expect('versions' in treatment).toBe(false);
    });

    it('lists every treatment when no filter is given', async () => {
      prisma.treatment.findMany.mockResolvedValue([]);

      await service.list('tenant-1', {});

      expect(prisma.treatment.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1' });
    });

    it('gets a treatment with every version, newest first', async () => {
      prisma.treatment.findFirst.mockResolvedValue(treatmentRow([versionRow(2), versionRow(1)]));

      const result = await service.get('tenant-1', 'treatment-1');

      expect(prisma.treatment.findFirst.mock.calls[0][0].include.versions).toEqual({
        orderBy: { version: 'desc' },
      });
      expect(result.versions.map((version) => version.version)).toEqual([2, 1]);
    });

    it('does not get a treatment of another tenant', async () => {
      prisma.treatment.findFirst.mockResolvedValue(null);

      const error = await failure(service.get('tenant-2', 'treatment-1'));

      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_NOT_FOUND' });
    });
  });

  describe('currentVersionFor', () => {
    it('returns the current version of an active treatment with the treatment', async () => {
      const treatment = treatmentRow([versionRow(2), versionRow(1)], { currentVersion: 2 });
      prisma.treatment.findFirst.mockResolvedValue(treatment);
      prisma.treatmentVersion.findFirst.mockResolvedValue(versionRow(2));

      const result = await service.currentVersionFor(db, 'tenant-1', 'treatment-1');

      expect(prisma.treatmentVersion.findFirst.mock.calls[0][0].where).toEqual({
        treatmentId: 'treatment-1',
        tenantId: 'tenant-1',
        version: 2,
      });
      expect(result).toMatchObject({
        id: 'version-2',
        version: 2,
        treatment: { id: 'treatment-1' },
      });
    });

    it('throws 409 TREATMENT_INACTIVE for an inactive treatment', async () => {
      prisma.treatment.findFirst.mockResolvedValue(
        treatmentRow([versionRow(1)], { isActive: false }),
      );

      const error = await failure(service.currentVersionFor(db, 'tenant-1', 'treatment-1'));

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_INACTIVE' });
    });

    it('does not find a treatment of another tenant', async () => {
      prisma.treatment.findFirst.mockResolvedValue(null);

      const error = await failure(service.currentVersionFor(db, 'tenant-2', 'treatment-1'));

      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_NOT_FOUND' });
      expect(prisma.treatment.findFirst.mock.calls[0][0].where).toEqual({
        id: 'treatment-1',
        tenantId: 'tenant-2',
      });
    });
  });
});
