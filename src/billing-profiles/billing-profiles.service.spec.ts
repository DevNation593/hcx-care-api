import { PrismaService } from '../prisma/prisma.service';
import { BillingProfilesService } from './billing-profiles.service';

describe('BillingProfilesService', () => {
  const prisma = {
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
    auditLog: { create: jest.fn() },
    patient: { findFirst: jest.fn() },
    billingProfile: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    patientBillingProfile: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const service = new BillingProfilesService(prisma as unknown as PrismaService);

  const profile = (extra: Record<string, unknown> = {}) => ({
    id: 'profile-1',
    tenantId: 'tenant-1',
    kind: 'PERSON',
    idType: '05',
    idNumber: '1710034065',
    legalName: 'María Pérez',
    email: 'maria@example.com',
    address: null,
    phone: null,
    isActive: true,
    createdById: 'user-1',
    ...extra,
  });

  const auditedChanges = () =>
    prisma.auditLog.create.mock.calls.map(([args]) => JSON.stringify(args.data.changes ?? null));

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (tx: unknown) => unknown) =>
      callback(prisma),
    );
    prisma.patient.findFirst.mockResolvedValue({ id: 'patient-1' });
    prisma.billingProfile.findFirst.mockResolvedValue(profile());
    prisma.patientBillingProfile.findMany.mockResolvedValue([]);
  });

  describe('create', () => {
    const dto = {
      kind: 'PERSON' as const,
      idType: '05' as const,
      idNumber: ' 1710034065 ',
      legalName: 'María Pérez',
      email: 'maria@example.com',
    };

    it('stores the canonical name of a final consumer on create', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(null);
      prisma.billingProfile.create.mockResolvedValue(profile({ idType: '07' }));

      await service.create('tenant-1', 'user-1', {
        kind: 'PERSON',
        idType: '07',
        idNumber: '9999999999999',
        legalName: ' Consumidor final ',
      });

      expect(prisma.billingProfile.create.mock.calls[0][0].data.legalName).toBe('CONSUMIDOR FINAL');
    });

    it('stores the normalized identification and audits without it', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(null);
      prisma.billingProfile.create.mockResolvedValue(profile());

      await service.create('tenant-1', 'user-1', dto);

      expect(prisma.billingProfile.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', idType: '05', idNumber: '1710034065' },
        select: { id: true },
      });
      expect(prisma.billingProfile.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-1',
        idNumber: '1710034065',
        createdById: 'user-1',
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'CREATE',
        entity: 'BILLING_PROFILE',
        entityId: 'profile-1',
        userId: 'user-1',
      });
      expect(auditedChanges().join()).not.toContain('1710034065');
      expect(auditedChanges().join()).toContain('"idType":"05"');
    });

    it('rejects an identification that already exists, even with different spacing', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue({ id: 'profile-0' });

      await expect(service.create('tenant-1', 'user-1', dto)).rejects.toMatchObject({
        response: { statusCode: 409, code: 'BILLING_PROFILE_DUPLICATE' },
      });
      expect(prisma.billingProfile.create).not.toHaveBeenCalled();
    });

    it('maps a unique violation raised by the database to the same conflict', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(null);
      prisma.billingProfile.create.mockRejectedValue({ code: 'P2002' });

      await expect(service.create('tenant-1', 'user-1', dto)).rejects.toMatchObject({
        response: { statusCode: 409, code: 'BILLING_PROFILE_DUPLICATE' },
      });
    });

    it('rejects an invalid cedula', async () => {
      await expect(
        service.create('tenant-1', 'user-1', { ...dto, idNumber: '1710034066' }),
      ).rejects.toMatchObject({ response: { code: 'BILLING_PROFILE_INVALID' } });
      expect(prisma.billingProfile.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('paginates with defaults and searches by name or identification prefix', async () => {
      prisma.billingProfile.findMany.mockResolvedValue([profile()]);
      prisma.billingProfile.count.mockResolvedValue(1);

      const result = await service.list('tenant-1', { q: 'mar', active: 'true' });

      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(prisma.billingProfile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId: 'tenant-1',
            isActive: true,
            OR: [
              { legalName: { contains: 'mar', mode: 'insensitive' } },
              { idNumber: { startsWith: 'mar' } },
            ],
          },
          skip: 0,
          take: 20,
        }),
      );
    });
  });

  describe('update', () => {
    it('writes only the editable fields and audits the change without the identification', async () => {
      prisma.billingProfile.update.mockResolvedValue(profile({ legalName: 'María P.' }));

      await service.update('tenant-1', 'user-1', 'profile-1', {
        legalName: 'María P.',
        idNumber: '0000000000',
        idType: '04',
      } as never);

      const data = prisma.billingProfile.update.mock.calls[0][0].data;
      expect(data).toEqual({ legalName: 'María P.' });
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: 'UPDATE',
        entity: 'BILLING_PROFILE',
        entityId: 'profile-1',
      });
      expect(auditedChanges().join()).not.toContain('1710034065');
    });

    it('clears the address when it is null', async () => {
      prisma.billingProfile.update.mockResolvedValue(profile());

      await service.update('tenant-1', 'user-1', 'profile-1', { address: null } as never);

      expect(prisma.billingProfile.update.mock.calls[0][0].data).toEqual({ address: null });
    });

    it('stores the canonical name of a final consumer whatever the input', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(
        profile({ idType: '07', idNumber: '9999999999999' }),
      );
      prisma.billingProfile.update.mockResolvedValue(profile({ idType: '07' }));

      await service.update('tenant-1', 'user-1', 'profile-1', {
        legalName: '  consumidor   Final ',
      });

      expect(prisma.billingProfile.update.mock.calls[0][0].data).toEqual({
        legalName: 'CONSUMIDOR FINAL',
      });
    });

    it('rejects clearing the e-mail of a profile that is not a final consumer', async () => {
      await expect(
        service.update('tenant-1', 'user-1', 'profile-1', { email: null } as never),
      ).rejects.toMatchObject({
        response: { statusCode: 422, code: 'BILLING_PROFILE_INVALID' },
      });
      expect(prisma.billingProfile.update).not.toHaveBeenCalled();
    });

    it('clears the e-mail of a final-consumer profile', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(profile({ idType: '07' }));
      prisma.billingProfile.update.mockResolvedValue(profile({ idType: '07', email: null }));

      await service.update('tenant-1', 'user-1', 'profile-1', { email: null } as never);

      expect(prisma.billingProfile.update.mock.calls[0][0].data).toEqual({ email: null });
    });

    it('answers 404 for a profile of another tenant', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(null);

      await expect(
        service.update('tenant-2', 'user-1', 'profile-1', { isActive: false }),
      ).rejects.toMatchObject({
        response: { statusCode: 404, code: 'BILLING_PROFILE_NOT_FOUND' },
      });
      expect(prisma.billingProfile.findFirst.mock.calls[0][0].where).toMatchObject({
        tenantId: 'tenant-2',
      });
    });
  });

  describe('get', () => {
    it('answers 404 for a profile of another tenant', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(null);
      await expect(service.get('tenant-2', 'profile-1')).rejects.toMatchObject({
        response: { code: 'BILLING_PROFILE_NOT_FOUND' },
      });
    });
  });

  describe('linkToPatient', () => {
    it('clears the previous default in the same transaction when isDefault is set', async () => {
      prisma.patientBillingProfile.findMany.mockResolvedValue([
        { isDefault: true, billingProfile: profile() },
      ]);

      const result = await service.linkToPatient('tenant-1', 'user-1', 'patient-1', {
        billingProfileId: 'profile-1',
        isDefault: true,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.patientBillingProfile.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', patientId: 'patient-1', isDefault: true },
        data: { isDefault: false },
      });
      expect(prisma.patientBillingProfile.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.patientBillingProfile.upsert.mock.invocationCallOrder[0],
      );
      expect(prisma.patientBillingProfile.upsert.mock.calls[0][0]).toMatchObject({
        create: { isDefault: true },
        update: { isDefault: true },
      });
      expect(result).toEqual([expect.objectContaining({ id: 'profile-1', isDefault: true })]);
      expect(auditedChanges().join()).not.toContain('1710034065');
    });

    it('does not touch the default when isDefault is not requested', async () => {
      await service.linkToPatient('tenant-1', 'user-1', 'patient-1', {
        billingProfileId: 'profile-1',
      });
      expect(prisma.patientBillingProfile.updateMany).not.toHaveBeenCalled();
    });

    it('rejects linking an inactive profile', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(profile({ isActive: false }));

      await expect(
        service.linkToPatient('tenant-1', 'user-1', 'patient-1', { billingProfileId: 'profile-1' }),
      ).rejects.toMatchObject({
        response: { statusCode: 409, code: 'BILLING_PROFILE_INACTIVE' },
      });
    });

    it('answers 404 for a profile of another tenant', async () => {
      prisma.billingProfile.findFirst.mockResolvedValue(null);

      await expect(
        service.linkToPatient('tenant-1', 'user-1', 'patient-1', { billingProfileId: 'other' }),
      ).rejects.toMatchObject({ response: { code: 'BILLING_PROFILE_NOT_FOUND' } });
      expect(prisma.billingProfile.findFirst.mock.calls[0][0].where).toMatchObject({
        tenantId: 'tenant-1',
      });
    });

    it('answers 404 for a missing or deleted patient', async () => {
      prisma.patient.findFirst.mockResolvedValue(null);

      await expect(
        service.linkToPatient('tenant-1', 'user-1', 'patient-9', { billingProfileId: 'profile-1' }),
      ).rejects.toMatchObject({
        response: { statusCode: 404, code: 'PATIENT_NOT_FOUND' },
      });
      expect(prisma.patient.findFirst).toHaveBeenCalledWith({
        where: { id: 'patient-9', tenantId: 'tenant-1', deletedAt: null },
        select: { id: true },
      });
    });
  });

  describe('unlinkFromPatient', () => {
    it('removes the link only and audits it', async () => {
      prisma.patientBillingProfile.deleteMany.mockResolvedValue({ count: 1 });

      await service.unlinkFromPatient('tenant-1', 'user-1', 'patient-1', 'profile-1');

      expect(prisma.patientBillingProfile.deleteMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', patientId: 'patient-1', billingProfileId: 'profile-1' },
      });
      expect(prisma.billingProfile.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('answers 404 when the link does not exist', async () => {
      prisma.patientBillingProfile.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        service.unlinkFromPatient('tenant-1', 'user-1', 'patient-1', 'profile-1'),
      ).rejects.toMatchObject({ response: { code: 'BILLING_PROFILE_NOT_FOUND' } });
    });
  });

  describe('listForPatient', () => {
    it('returns the linked profiles with their default flag', async () => {
      prisma.patientBillingProfile.findMany.mockResolvedValue([
        { isDefault: false, billingProfile: profile() },
      ]);

      await expect(service.listForPatient('tenant-1', 'patient-1')).resolves.toEqual([
        expect.objectContaining({ id: 'profile-1', isDefault: false }),
      ]);
    });
  });
});
