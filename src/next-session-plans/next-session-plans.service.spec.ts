import { LEGACY_BILLING_OMIT } from '../patients/legacy-billing';
import { PrismaService } from '../prisma/prisma.service';
import { NextSessionPlansService } from './next-session-plans.service';

describe('NextSessionPlansService', () => {
  const prisma = { nextSessionPlan: { findFirst: jest.fn(), update: jest.fn() } };
  let service: NextSessionPlansService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new NextSessionPlansService(prisma as unknown as PrismaService);
  });

  it('leaves the legacy billing columns of the patient out of the plan of a patient', async () => {
    prisma.nextSessionPlan.findFirst.mockResolvedValue({ id: 'plan-1' });
    await service.findByPatient('tenant-1', 'patient-1');
    expect(prisma.nextSessionPlan.findFirst.mock.calls[0][0].include.patient).toEqual({
      omit: LEGACY_BILLING_OMIT,
    });
  });
});
