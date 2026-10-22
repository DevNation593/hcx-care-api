import { ProfessionalProfilesService } from './professional-profiles.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ProfessionalProfilesService', () => {
  const db = {
    tenantSpecialty: { findUnique: jest.fn() },
    professionalProfile: { count: jest.fn(), findUnique: jest.fn() },
    tenantSubscription: { findUnique: jest.fn(), update: jest.fn() },
    appointment: { count: jest.fn() },
  };
  let service: ProfessionalProfilesService;
  beforeEach(() => {
    jest.resetAllMocks();
    service = new ProfessionalProfilesService(db as unknown as PrismaService);
  });

  it.each(['PROFESIONAL'])('%s requires a specialty', (role) => {
    expect(() => service.validateRoleProfile(role)).toThrow(
      expect.objectContaining({
        status: 422,
        response: expect.objectContaining({ code: 'PROFESSIONAL_SPECIALTY_REQUIRED' }),
      }),
    );
  });
  it.each(['MASTER'])('%s accepts an optional profile', (role) => {
    expect(() => service.validateRoleProfile(role)).not.toThrow();
    expect(() => service.validateRoleProfile(role, { specialtyId: 's' })).not.toThrow();
  });
  it.each(['ASISTENTE', 'SOPORTE', 'PACIENTE'])('%s rejects a profile', (role) => {
    expect(() => service.validateRoleProfile(role, { specialtyId: 's' })).toThrow(
      expect.objectContaining({
        status: 422,
        response: expect.objectContaining({ code: 'PROFESSIONAL_PROFILE_NOT_ALLOWED' }),
      }),
    );
  });
  it('rejects specialties not enabled for the tenant', async () => {
    db.tenantSpecialty.findUnique.mockResolvedValue(null);
    await expect(service.assertSpecialtyEnabled('t', 's')).rejects.toMatchObject({
      status: 409,
      response: { code: 'SPECIALTY_NOT_ENABLED' },
    });
  });
  it('checks the live profile count at the limit instead of the stale counter', async () => {
    db.tenantSubscription.findUnique.mockResolvedValue({
      seatsPsychologistsMax: 1,
      seatsPsychologistsUsed: 0,
    });
    db.professionalProfile.count.mockResolvedValue(1);
    await expect(service.assertSeatAvailable('t')).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROFESSIONAL_SEAT_LIMIT_REACHED', details: { used: 1, limit: 1 } },
    });
  });
  it('counts only active profiles and does not filter by user role or login state', async () => {
    db.professionalProfile.count.mockResolvedValue(2);
    expect(await service.countActiveProfiles('t')).toBe(2);
    expect(db.professionalProfile.count).toHaveBeenCalledWith({
      where: { isActive: true, user: { tenantId: 't' } },
    });
  });
  it('blocks a specialty change with future appointments of the current specialty', async () => {
    db.professionalProfile.findUnique.mockResolvedValue({ specialtyId: 'old' });
    db.appointment.count.mockResolvedValue(1);
    await expect(service.assertSpecialtyChangeAllowed('t', 'u', 'new')).rejects.toMatchObject({
      status: 409,
      response: { code: 'SPECIALTY_IN_USE' },
    });
    expect(db.appointment.count).toHaveBeenCalledWith({
      where: {
        tenantId: 't',
        psychologistId: 'u',
        specialtyId: 'old',
        startTime: { gte: expect.any(Date) },
        status: { in: ['SCHEDULED', 'CONFIRMED'] },
      },
    });
  });
  it('allows keeping a specialty even with future appointments', async () => {
    db.professionalProfile.findUnique.mockResolvedValue({ specialtyId: 'old' });
    await expect(service.assertSpecialtyChangeAllowed('t', 'u', 'old')).resolves.toBeUndefined();
    expect(db.appointment.count).not.toHaveBeenCalled();
  });
});
