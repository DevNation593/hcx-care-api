import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { HealthSpecialtyGuard } from './health-specialty.guard';
import { PrismaService } from '../prisma/prisma.service';
import { ClinicalNotesController } from '../clinical-notes/clinical-notes.controller';
import { NextSessionPlansController } from '../next-session-plans/next-session-plans.controller';

describe('HealthSpecialtyGuard', () => {
  const prisma = { professionalProfile: { findFirst: jest.fn() } };
  const guard = new HealthSpecialtyGuard(prisma as unknown as PrismaService);
  const context = () =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user: { userId: 'user-1', tenantId: 'tenant-1' } }),
      }),
    }) as unknown as ExecutionContext;
  const withProfile = (code: string | null) =>
    prisma.professionalProfile.findFirst.mockResolvedValue(code ? { specialty: { code } } : null);

  beforeEach(() => jest.resetAllMocks());

  it('refuses a professional of a non-health specialty', async () => {
    withProfile('AESTHETICS');

    await expect(guard.canActivate(context())).rejects.toMatchObject({
      status: 403,
      response: { code: 'HEALTH_SPECIALTY_REQUIRED' },
    });
    expect(prisma.professionalProfile.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', isActive: true, user: { tenantId: 'tenant-1', isActive: true } },
      select: { specialty: { select: { code: true } } },
    });
  });

  it('lets a health professional of the same clinic through', async () => {
    withProfile('GENERAL_MEDICINE');
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  it('leaves an account without a profile to the other guards', async () => {
    withProfile(null);
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  it('guards creating clinical notes and next session plans', () => {
    for (const handler of [
      ClinicalNotesController.prototype.create,
      NextSessionPlansController.prototype.create,
    ]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(HealthSpecialtyGuard);
    }
  });
});
