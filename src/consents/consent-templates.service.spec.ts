import { PrismaService } from '../prisma/prisma.service';
import { consentChecksum } from './consent-text';
import { ConsentTemplatesService } from './consent-templates.service';

describe('ConsentTemplatesService', () => {
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    consentTemplate: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    consentTemplateVersion: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const service = new ConsentTemplatesService(prisma as unknown as PrismaService);

  const draft = (version: number, extra: Record<string, unknown> = {}) => ({
    id: `version-${version}`,
    tenantId: 'tenant-1',
    templateId: 'template-1',
    version,
    title: 'Consentimiento',
    body: 'Yo, {{paciente}}, acepto.',
    checksum: consentChecksum('Consentimiento', 'Yo, {{paciente}}, acepto.'),
    status: 'DRAFT',
    publishedAt: null,
    retiredAt: null,
    ...extra,
  });
  const template = (versions: unknown[], currentVersion = 1) => ({
    id: 'template-1',
    tenantId: 'tenant-1',
    name: 'Botox',
    currentVersion,
    versions,
  });

  async function failure(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      return error as { getStatus(): number; getResponse(): Record<string, unknown> };
    }
    throw new Error('expected the call to fail');
  }

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.consentTemplate.create.mockImplementation(({ data }) => ({ id: 'template-1', ...data }));
    prisma.consentTemplateVersion.updateMany.mockResolvedValue({ count: 1 });
  });

  it('lists the templates of the tenant with their versions but not their text', async () => {
    await service.list('tenant-1');

    const args = prisma.consentTemplate.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: 'tenant-1' });
    expect(args.include.versions.select.status).toBe(true);
    expect(args.include.versions.select.body).toBeUndefined();
  });

  it('stores a new template as version 1 in draft, trimmed, with its author', async () => {
    await service.create('tenant-1', 'user-1', {
      name: '  Botox ',
      title: ' Consentimiento ',
      body: ' Yo, {{paciente}}, acepto. ',
    });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.applyRlsContext).toHaveBeenCalledWith(prisma);
    const { data } = prisma.consentTemplate.create.mock.calls[0][0];
    expect(data).toMatchObject({ tenantId: 'tenant-1', name: 'Botox', currentVersion: 1 });
    expect(data.versions.create).toEqual({
      tenantId: 'tenant-1',
      version: 1,
      title: 'Consentimiento',
      body: 'Yo, {{paciente}}, acepto.',
      // A draft has no published fingerprint yet; this one follows the text until it is published.
      checksum: consentChecksum('Consentimiento', 'Yo, {{paciente}}, acepto.'),
      status: 'DRAFT',
      createdById: 'user-1',
    });
  });

  it('rejects a name the clinic already uses', async () => {
    prisma.consentTemplate.create.mockRejectedValue({ code: 'P2002' });

    const error = await failure(
      service.create('tenant-1', 'user-1', { name: 'Botox', title: 'Titulo', body: 'Texto' }),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'CONSENT_TEMPLATE_NAME_TAKEN' });
  });

  it('publishes the draft with the fingerprint of its text and moves currentVersion', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(template([draft(1)]));

    await service.publish('tenant-1', 'user-1', 'template-1');

    const update = prisma.consentTemplateVersion.updateMany.mock.calls[0][0];
    expect(update.where).toEqual({
      id: 'version-1',
      tenantId: 'tenant-1',
      status: 'DRAFT',
      title: 'Consentimiento',
      body: 'Yo, {{paciente}}, acepto.',
    });
    expect(update.data).toMatchObject({
      status: 'PUBLISHED',
      checksum: consentChecksum('Consentimiento', 'Yo, {{paciente}}, acepto.'),
    });
    expect(update.data.publishedAt).toBeInstanceOf(Date);
    expect(prisma.consentTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'template-1' }, data: { currentVersion: 1 } }),
    );
  });

  it('refuses to publish when there is no draft', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(
      template([draft(1, { status: 'PUBLISHED' })]),
    );

    const error = await failure(service.publish('tenant-1', 'user-1', 'template-1'));

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'CONSENT_VERSION_LOCKED' });
    expect(prisma.consentTemplateVersion.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to publish a draft that was published or edited by another request', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(template([draft(1)]));
    prisma.consentTemplateVersion.updateMany.mockResolvedValue({ count: 0 });

    const error = await failure(service.publish('tenant-1', 'user-1', 'template-1'));

    expect(error.getResponse()).toMatchObject({ code: 'CONSENT_VERSION_LOCKED' });
    expect(prisma.consentTemplate.update).not.toHaveBeenCalled();
  });

  it('starts version 2 as a draft after publishing and leaves version 1 as it is', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(
      template([draft(1, { status: 'PUBLISHED' })]),
    );

    await service.saveDraft('tenant-1', 'user-1', 'template-1', {
      title: 'Consentimiento v2',
      body: 'Texto nuevo',
    });

    expect(prisma.consentTemplateVersion.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        templateId: 'template-1',
        version: 2,
        title: 'Consentimiento v2',
        body: 'Texto nuevo',
        checksum: consentChecksum('Consentimiento v2', 'Texto nuevo'),
        status: 'DRAFT',
        createdById: 'user-1',
      },
    });
    expect(prisma.consentTemplateVersion.updateMany).not.toHaveBeenCalled();
  });

  it('numbers the new draft after the highest version, not after the published one', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(
      template([draft(3, { status: 'RETIRED' }), draft(2, { status: 'PUBLISHED' })], 2),
    );

    await service.saveDraft('tenant-1', 'user-1', 'template-1', { title: 'Titulo', body: 'Texto' });

    expect(prisma.consentTemplateVersion.create.mock.calls[0][0].data.version).toBe(4);
  });

  it('replaces the text of the open draft instead of adding another version', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(
      template([draft(2), draft(1, { status: 'PUBLISHED' })]),
    );

    await service.saveDraft('tenant-1', 'user-1', 'template-1', {
      title: ' Segundo ',
      body: ' Texto ',
    });

    expect(prisma.consentTemplateVersion.create).not.toHaveBeenCalled();
    expect(prisma.consentTemplateVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'version-2', tenantId: 'tenant-1', status: 'DRAFT' },
      data: { title: 'Segundo', body: 'Texto', checksum: consentChecksum('Segundo', 'Texto') },
    });
  });

  it('does not rewrite a draft that was published while it was being saved', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(template([draft(1)]));
    prisma.consentTemplateVersion.updateMany.mockResolvedValue({ count: 0 });

    const error = await failure(
      service.saveDraft('tenant-1', 'user-1', 'template-1', { title: 'Titulo', body: 'Texto' }),
    );

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'CONSENT_VERSION_LOCKED' });
    expect(prisma.consentTemplateVersion.create).not.toHaveBeenCalled();
  });

  it('retires a published version', async () => {
    prisma.consentTemplateVersion.findFirst.mockResolvedValue(draft(1, { status: 'PUBLISHED' }));

    await service.retire('tenant-1', 'version-1');

    expect(prisma.consentTemplateVersion.findFirst).toHaveBeenCalledWith({
      where: { id: 'version-1', tenantId: 'tenant-1' },
    });
    const { where, data } = prisma.consentTemplateVersion.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'version-1' });
    expect(data.status).toBe('RETIRED');
    expect(data.retiredAt).toBeInstanceOf(Date);
  });

  it.each(['DRAFT', 'RETIRED'])('refuses to retire a %s version', async (status) => {
    prisma.consentTemplateVersion.findFirst.mockResolvedValue(draft(1, { status }));

    const error = await failure(service.retire('tenant-1', 'version-1'));

    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({ code: 'CONSENT_VERSION_LOCKED' });
    expect(prisma.consentTemplateVersion.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a template or version of another tenant', async () => {
    prisma.consentTemplate.findFirst.mockResolvedValue(null);
    prisma.consentTemplateVersion.findFirst.mockResolvedValue(null);

    const errors = await Promise.all([
      failure(service.get('tenant-1', 'foreign')),
      failure(
        service.saveDraft('tenant-1', 'user-1', 'foreign', { title: 'Titulo', body: 'Texto' }),
      ),
      failure(service.publish('tenant-1', 'user-1', 'foreign')),
      failure(service.retire('tenant-1', 'foreign')),
    ]);

    for (const error of errors) {
      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toMatchObject({ code: 'CONSENT_TEMPLATE_NOT_FOUND' });
    }
    expect(prisma.consentTemplate.findFirst.mock.calls[0][0].where).toEqual({
      id: 'foreign',
      tenantId: 'tenant-1',
    });
  });

  describe('assertPublishedVersion', () => {
    it('returns the published version of the tenant', async () => {
      const published = draft(1, { status: 'PUBLISHED' });
      prisma.consentTemplateVersion.findFirst.mockResolvedValue(published);

      await expect(
        service.assertPublishedVersion(prisma as unknown as PrismaService, 'tenant-1', 'version-1'),
      ).resolves.toBe(published);
    });

    it.each([null, draft(1), draft(1, { status: 'RETIRED' })])(
      'rejects a version that is missing, draft or retired',
      async (found) => {
        prisma.consentTemplateVersion.findFirst.mockResolvedValue(found);

        const error = await failure(
          service.assertPublishedVersion(
            prisma as unknown as PrismaService,
            'tenant-1',
            'version-1',
          ),
        );

        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toMatchObject({ code: 'TREATMENT_REQUIREMENTS_INVALID' });
      },
    );
  });
});
