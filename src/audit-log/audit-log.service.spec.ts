import { AuditLogService } from './audit-log.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { PrismaService } from '../prisma/prisma.service';

describe('AuditLogService clinical content', () => {
  const plain = new ClinicalCipher();
  const snapshot = { before: { content: 'Original' }, after: { content: 'Corregido' } };
  const logs = [
    { id: 'a', entity: 'CLINICAL_NOTE', action: 'UPDATE', changes: snapshot, reason: 'Errata' },
    { id: 'b', entity: 'SPECIALTY_RECORD', action: 'CREATE', changes: snapshot, reason: null },
    { id: 'c', entity: 'PATIENT', action: 'UPDATE', changes: { phone: '1' }, reason: null },
  ];
  const prisma = {
    auditLog: { findMany: jest.fn() },
    professionalProfile: { findFirst: jest.fn() },
  };
  const service = new AuditLogService(prisma as unknown as PrismaService, plain);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.auditLog.findMany.mockResolvedValue(logs);
  });

  it('hides clinical snapshots from a MASTER without an active professional profile', async () => {
    prisma.professionalProfile.findFirst.mockResolvedValue(null);

    const result = await service.findAll('tenant-1', 'master');

    expect(prisma.professionalProfile.findFirst.mock.calls[0][0].where).toEqual({
      userId: 'master',
      isActive: true,
      user: { tenantId: 'tenant-1', isActive: true },
    });
    expect(result).toEqual([
      expect.objectContaining({ id: 'a', action: 'UPDATE', changes: null, reason: null }),
      expect.objectContaining({ id: 'b', changes: null, contentRedacted: true }),
      expect.objectContaining({ id: 'c', changes: { phone: '1' }, contentRedacted: false }),
    ]);
  });

  it('shows the full history of a record to a viewer with an active profile', async () => {
    prisma.professionalProfile.findFirst.mockResolvedValue({ userId: 'master' });

    const result = await service.findByEntity('tenant-1', 'master', 'CLINICAL_NOTE', 'note-1');

    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 'tenant-1',
      entity: 'CLINICAL_NOTE',
      entityId: 'note-1',
    });
    expect(result[0]).toMatchObject({
      changes: snapshot,
      reason: 'Errata',
      contentRedacted: false,
    });
  });
});

describe('AuditLogService, clinical orders, results and follow-ups', () => {
  const cipher = new ClinicalCipher([{ id: 'k1', key: Buffer.alloc(32, 5) }]);
  const changes = cipher.encryptJson('tenant-1', {
    before: null,
    after: { studyName: 'Citología' },
  });
  const logs = ['CLINICAL_ORDER', 'CLINICAL_RESULT', 'CLINICAL_FOLLOW_UP'].map((entity, index) => ({
    id: `log-${index}`,
    tenantId: 'tenant-1',
    entity,
    action: 'UPDATE',
    changes,
    reason: cipher.encrypt('tenant-1', 'Revisión del resultado'),
  }));
  const prisma = {
    auditLog: { findMany: jest.fn() },
    professionalProfile: { findFirst: jest.fn() },
  };
  const service = new AuditLogService(prisma as unknown as PrismaService, cipher);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.auditLog.findMany.mockResolvedValue(logs);
  });

  it('decrypts their snapshots for a viewer with an active profile', async () => {
    prisma.professionalProfile.findFirst.mockResolvedValue({ userId: 'master' });

    const result = await service.findAll('tenant-1', 'master');

    for (const entry of result) {
      expect(entry).toMatchObject({
        changes: { before: null, after: { studyName: 'Citología' } },
        reason: 'Revisión del resultado',
        contentRedacted: false,
      });
    }
  });

  it('hides them from an account holder without a profile', async () => {
    prisma.professionalProfile.findFirst.mockResolvedValue(null);

    const result = await service.findAll('tenant-1', 'master');

    for (const entry of result) {
      expect(entry).toMatchObject({ changes: null, reason: null, contentRedacted: true });
    }
  });
});
