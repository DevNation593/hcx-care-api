import { PrismaService } from '../prisma/prisma.service';
import { ClinicalModulesService } from './clinical-modules.service';

describe('ClinicalModulesService', () => {
  const schema = {
    sections: [{ key: 's', title: 'S', fields: [{ key: 'a', label: 'A', type: 'text' }] }],
  };
  const db = {
    professionalProfile: { findFirst: jest.fn() },
    tenantSpecialty: { findMany: jest.fn() },
    tenantModule: { findMany: jest.fn() },
    formDefinition: { findMany: jest.fn() },
  };
  const service = new ClinicalModulesService(db as unknown as PrismaService);

  const flags = (modules: Awaited<ReturnType<ClinicalModulesService['listForTenant']>>) =>
    Object.fromEntries(
      modules.map(({ moduleKey, schemaVersion, enabled, canRecord }) => [
        `${moduleKey}@${schemaVersion}`,
        { enabled, canRecord },
      ]),
    );

  beforeEach(() => {
    jest.resetAllMocks();
    db.professionalProfile.findFirst.mockResolvedValue({
      specialtyId: 'nutrition',
      specialty: { code: 'NUTRITION' },
    });
    db.tenantSpecialty.findMany.mockResolvedValue([
      { specialty: { code: 'NUTRITION' } },
      { specialty: { code: 'PSYCHOLOGY' } },
    ]);
    db.tenantModule.findMany.mockResolvedValue([
      { moduleKey: 'nutrition.assessments' },
      { moduleKey: 'psychology.phq9' },
      // Left enabled after its specialty was removed from the clinic.
      { moduleKey: 'dentistry.odontogram' },
    ]);
    db.formDefinition.findMany.mockResolvedValue([]);
  });

  it('scopes every lookup to the tenant and the active profile of the caller', async () => {
    await service.listForTenant('tenant-1', 'user-1');

    expect(db.professionalProfile.findFirst.mock.calls[0][0].where).toEqual({
      userId: 'user-1',
      isActive: true,
      user: { tenantId: 'tenant-1', isActive: true },
    });
    expect(db.tenantModule.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant-1',
      enabled: true,
    });
    expect(db.formDefinition.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1' });
  });

  it('lets a professional record only current versions of enabled modules of their specialty', async () => {
    const modules = flags(await service.listForTenant('tenant-1', 'user-1'));

    expect(modules['nutrition.assessments@2']).toEqual({ enabled: true, canRecord: true });
    // Earlier versions stay listed so stored records can be rendered, but are not writable.
    expect(modules['nutrition.assessments@1']).toEqual({ enabled: true, canRecord: false });
    // Disabled by the clinic.
    expect(modules['nutrition.diet-plans@2']).toEqual({ enabled: false, canRecord: false });
    // Another specialty of the clinic: readable history, no writing.
    expect(modules['psychology.phq9@1']).toEqual({ enabled: true, canRecord: false });
    // The module row exists but the clinic no longer has the specialty.
    expect(modules['dentistry.odontogram@2']).toEqual({ enabled: false, canRecord: false });
  });

  it('opens general modules to every professional except those reserved to prescribers', async () => {
    const nutritionist = flags(await service.listForTenant('tenant-1', 'user-1'));
    expect(nutritionist['general.vital-signs@1']).toEqual({ enabled: true, canRecord: true });
    expect(nutritionist['general.prescriptions@1']).toEqual({ enabled: true, canRecord: false });

    db.professionalProfile.findFirst.mockResolvedValue({
      specialtyId: 'dentistry',
      specialty: { code: 'DENTISTRY' },
    });
    const dentist = flags(await service.listForTenant('tenant-1', 'user-2'));
    expect(dentist['general.prescriptions@1']).toEqual({ enabled: true, canRecord: true });
  });

  describe('health-only modules', () => {
    const asAesthetician = () =>
      db.professionalProfile.findFirst.mockResolvedValue({
        specialtyId: 'aesthetics',
        specialty: { code: 'AESTHETICS' },
      });
    const clinicWith = (...codes: string[]) =>
      db.tenantSpecialty.findMany.mockResolvedValue(codes.map((code) => ({ specialty: { code } })));

    it('are off in a clinic that only has Estética, while shared modules stay usable', async () => {
      asAesthetician();
      clinicWith('AESTHETICS');
      const modules = flags(await service.listForTenant('tenant-1', 'user-1'));

      expect(modules['general.soap-note@1']).toEqual({ enabled: false, canRecord: false });
      expect(modules['general.vital-signs@1']).toEqual({ enabled: false, canRecord: false });
      expect(modules['general.allergies@1']).toEqual({ enabled: true, canRecord: true });
    });

    it('stay on in a mixed clinic but only for its health professionals', async () => {
      asAesthetician();
      clinicWith('AESTHETICS', 'GENERAL_MEDICINE');
      const aesthetician = flags(await service.listForTenant('tenant-1', 'user-1'));
      expect(aesthetician['general.soap-note@1']).toEqual({ enabled: true, canRecord: false });

      db.professionalProfile.findFirst.mockResolvedValue({
        specialtyId: 'general-medicine',
        specialty: { code: 'GENERAL_MEDICINE' },
      });
      const physician = flags(await service.listForTenant('tenant-1', 'user-2'));
      expect(physician['general.soap-note@1']).toEqual({ enabled: true, canRecord: true });
    });
  });

  it('lets an account without a professional profile read definitions but record nothing', async () => {
    db.professionalProfile.findFirst.mockResolvedValue(null);

    const modules = await service.listForTenant('tenant-1', 'master');

    expect(modules.length).toBeGreaterThan(0);
    expect(modules.some(({ canRecord }) => canRecord)).toBe(false);
  });

  it('lists every version of the tenant forms under custom.<id>', async () => {
    db.formDefinition.findMany.mockResolvedValue([
      {
        id: 'form-1',
        name: 'Ficha de lesión',
        description: null,
        category: 'Evaluación',
        isActive: true,
        specialtyId: null,
        specialty: null,
        currentVersion: 2,
        versions: [
          { version: 1, schema },
          { version: 2, schema },
        ],
      },
      {
        id: 'form-2',
        name: 'Solo fisioterapia',
        description: null,
        category: null,
        isActive: true,
        specialtyId: 'physio',
        specialty: { code: 'PHYSIOTHERAPY' },
        currentVersion: 1,
        versions: [{ version: 1, schema }],
      },
      {
        id: 'form-3',
        name: 'Retirado',
        description: null,
        category: null,
        isActive: false,
        specialtyId: null,
        specialty: null,
        currentVersion: 1,
        versions: [{ version: 1, schema }],
      },
    ]);

    const modules = await service.listForTenant('tenant-1', 'user-1');
    const custom = modules.filter(({ scope }) => scope === 'CUSTOM');

    expect(
      custom.map(({ moduleKey, schemaVersion, isLatest }) => [moduleKey, schemaVersion, isLatest]),
    ).toEqual([
      ['custom.form-1', 1, false],
      ['custom.form-1', 2, true],
      ['custom.form-2', 1, true],
      ['custom.form-3', 1, true],
    ]);
    expect(flags(custom)).toEqual({
      'custom.form-1@1': { enabled: true, canRecord: false },
      'custom.form-1@2': { enabled: true, canRecord: true },
      'custom.form-2@1': { enabled: true, canRecord: false },
      'custom.form-3@1': { enabled: false, canRecord: false },
    });
    expect(custom[0]).toMatchObject({
      name: 'Ficha de lesión',
      category: 'Evaluación',
      renderer: 'FORM',
    });
  });
});
