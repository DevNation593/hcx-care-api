import { PrismaService } from '../prisma/prisma.service';
import { DocumentVerificationService } from './document-verification.service';

describe('DocumentVerificationService', () => {
  const prisma = { specialtyRecord: { findUnique: jest.fn() } };
  const service = new DocumentVerificationService(prisma as unknown as PrismaService);
  const stored = (overrides = {}) => ({
    moduleKey: 'general.certificates',
    schemaVersion: 1,
    recordDate: new Date('2026-10-03T15:00:00.000Z'),
    version: 1,
    updatedAt: new Date('2026-10-03T15:00:00.000Z'),
    deletedAt: null,
    amendedBy: null,
    tenant: { name: 'Centro Bienestar' },
    specialty: { name: 'Psicología' },
    patient: { firstName: 'ana maría', lastName: 'Pérez Luna' },
    formDefinition: null,
    professional: {
      firstName: 'Sofía',
      lastName: 'Ruiz',
      professionalProfile: { professionalTitle: 'Psicóloga clínica', licenseNumber: 'MSP-123' },
    },
    ...overrides,
  });

  beforeEach(() => jest.resetAllMocks());

  it('confirms a document with who issued it and only the initials of the patient', async () => {
    prisma.specialtyRecord.findUnique.mockResolvedValue(stored());

    const result = await service.verify('abcd-efgh-jkmn-pqrs');

    expect(prisma.specialtyRecord.findUnique.mock.calls[0][0].where).toEqual({
      verificationCode: 'ABCDEFGHJKMNPQRS',
    });
    expect(result).toEqual({
      code: 'ABCD-EFGH-JKMN-PQRS',
      status: 'VALID',
      documentType: 'Certificado',
      issuedAt: new Date('2026-10-03T15:00:00.000Z'),
      correctedAt: null,
      withdrawnAt: null,
      clinic: 'Centro Bienestar',
      specialty: 'Psicología',
      professional: { name: 'Sofía Ruiz', title: 'Psicóloga clínica', licenseNumber: 'MSP-123' },
      patientInitials: 'A. M. P. L.',
    });
  });

  it('never selects the content of the record', async () => {
    prisma.specialtyRecord.findUnique.mockResolvedValue(stored());

    await service.verify('ABCDEFGHJKMNPQRS');

    const { select } = prisma.specialtyRecord.findUnique.mock.calls[0][0];
    expect(select.data).toBeUndefined();
    expect(select.notes).toBeUndefined();
    expect(select.patient).toEqual({ select: { firstName: true, lastName: true } });
  });

  it('tells a withdrawn document and a corrected one apart from a valid one', async () => {
    const deletedAt = new Date('2026-10-04T10:00:00.000Z');
    prisma.specialtyRecord.findUnique.mockResolvedValueOnce(stored({ deletedAt }));
    await expect(service.verify('ABCDEFGHJKMNPQRS')).resolves.toMatchObject({
      status: 'WITHDRAWN',
      withdrawnAt: deletedAt,
    });

    const updatedAt = new Date('2026-10-05T10:00:00.000Z');
    prisma.specialtyRecord.findUnique.mockResolvedValueOnce(stored({ version: 2, updatedAt }));
    await expect(service.verify('ABCDEFGHJKMNPQRS')).resolves.toMatchObject({
      status: 'VALID',
      correctedAt: updatedAt,
    });
  });

  it('tells the holder of a signed document that an addendum corrected it', async () => {
    const amendedAt = new Date('2026-10-06T10:00:00.000Z');
    prisma.specialtyRecord.findUnique.mockResolvedValueOnce(
      stored({ amendedBy: { createdAt: amendedAt } }),
    );

    await expect(service.verify('ABCDEFGHJKMNPQRS')).resolves.toMatchObject({
      status: 'VALID',
      correctedAt: amendedAt,
    });
  });

  it('names a form designed by the clinic by its own name', async () => {
    prisma.specialtyRecord.findUnique.mockResolvedValue(
      stored({ moduleKey: 'custom.form-1', formDefinition: { name: 'Ficha de lesión' } }),
    );

    await expect(service.verify('ABCDEFGHJKMNPQRS')).resolves.toMatchObject({
      documentType: 'Ficha de lesión',
    });
  });

  it('answers 404 for an unknown code and does not query for one that cannot exist', async () => {
    prisma.specialtyRecord.findUnique.mockResolvedValue(null);
    await expect(service.verify('ABCDEFGHJKMNPQRS')).rejects.toMatchObject({
      status: 404,
      response: { code: 'DOCUMENT_NOT_FOUND' },
    });

    prisma.specialtyRecord.findUnique.mockClear();
    await expect(service.verify("'; DROP TABLE")).rejects.toMatchObject({ status: 404 });
    expect(prisma.specialtyRecord.findUnique).not.toHaveBeenCalled();
  });
});
