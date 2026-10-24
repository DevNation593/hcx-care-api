import { MailService } from '../src/mail/mail.service';
import { UsersService } from '../src/users/users.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { ProfessionalProfilesService } from '../src/professional-profiles/professional-profiles.service';
import { CreateUserDto, UpdateUserDto } from '../src/users/dto/user.dto';
import { Prisma, UserRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RlsContextService } from '../src/prisma/rls-context.service';
import { PatientTeamService } from '../src/patient-team/patient-team.service';

describe('Users - profile seat enforcement', () => {
  let service: UsersService;
  let db: any;
  let users: any[];
  let subscription: any;
  const dto = (role: UserRole = 'PROFESIONAL', extra: any = {}): CreateUserDto => ({
    tenantId: 't',
    email: 'u@test.com',
    password: 'Password123!',
    firstName: 'A',
    lastName: 'B',
    role,
    professionalProfile: { specialtyId: 's' },
    ...extra,
  });
  const seed = (extra: any = {}) => {
    const user = {
      id: 'u',
      tenantId: 't',
      role: 'PROFESIONAL',
      isActive: true,
      managedByProvider: true,
      professionalProfile: { specialtyId: 's', isActive: true },
      ...extra,
    };
    users.push(user);
    return user;
  };
  beforeEach(() => {
    users = [];
    subscription = {
      planType: 'CLINIC_BASIC',
      status: 'ACTIVE',
      seatsPsychologistsMax: 1,
      seatsPsychologistsUsed: 99,
    };
    db = {
      tenant: { findUnique: jest.fn().mockResolvedValue({ tenantType: 'CLINIC' }) },
      tenantSpecialty: { findUnique: jest.fn().mockResolvedValue({ specialtyId: 's' }) },
      tenantSubscription: {
        findUnique: jest.fn(async () => subscription),
        update: jest.fn(async ({ data }) => Object.assign(subscription, data)),
      },
      professionalProfile: {
        count: jest.fn(
          async () =>
            users.filter((u) => u.tenantId === 't' && u.professionalProfile?.isActive).length,
        ),
        findUnique: jest.fn(
          async ({ where }) =>
            users.find((u) => u.id === where.userId)?.professionalProfile ?? null,
        ),
      },
      appointment: { count: jest.fn().mockResolvedValue(0) },
      user: {
        count: jest.fn(
          async ({ where }) =>
            users.filter(
              (u) =>
                u.tenantId === where.tenantId &&
                u.id !== where.id?.not &&
                u.isActive &&
                u.role === where.role,
            ).length,
        ),
        findUnique: jest.fn(
          async ({ where }) => users.find((u) => u.email === where.tenantId_email.email) ?? null,
        ),
        findFirst: jest.fn(
          async ({ where }) =>
            users.find((u) => u.id === where.id && u.tenantId === where.tenantId) ?? null,
        ),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async ({ data }) => {
          const user = {
            ...data,
            id: 'u' + users.length,
            professionalProfile: data.professionalProfile?.create ?? null,
            professionalSpecialties: data.professionalSpecialties
              ? [data.professionalSpecialties.create]
              : [],
          };
          users.push(user);
          return user;
        }),
        update: jest.fn(async ({ where, data }) => {
          const user = users.find((u) => u.id === where.id);
          const { professionalProfile, professionalSpecialties, ...fields } = data;
          Object.assign(
            user,
            Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
          );
          if (professionalProfile?.delete) user.professionalProfile = null;
          if (professionalProfile?.upsert)
            user.professionalProfile = {
              ...user.professionalProfile,
              ...(user.professionalProfile
                ? professionalProfile.upsert.update
                : professionalProfile.upsert.create),
            };
          if (professionalProfile?.update)
            Object.assign(user.professionalProfile, professionalProfile.update);
          if (professionalSpecialties)
            user.professionalSpecialties = professionalSpecialties.create
              ? [professionalSpecialties.create]
              : [];
          return user;
        }),
      },
      applyRlsContext: jest.fn(),
      $transaction: jest.fn(async (callback) => callback(db)),
    };
    const prisma = db as PrismaService;
    service = new UsersService(
      prisma,
      { hashPassword: async () => 'hash' } as unknown as AuthService,
      new ProfessionalProfilesService(prisma),
      {
        assertNoFutureAppointmentsForProfessional: jest.fn().mockResolvedValue(undefined),
        deactivateAllForProfessional: jest.fn().mockResolvedValue(0),
      } as unknown as PatientTeamService,
      { sendInvitation: jest.fn().mockResolvedValue(true) } as unknown as MailService,
    );
  });

  it('active PROFESIONAL profile consumes one seat and mirrors legacy data', async () => {
    const result = await service.create(dto('PROFESIONAL'), 'actor');
    expect(result).toMatchObject({ professionalProfile: { specialtyId: 's', isActive: true } });
    expect(users[0].professionalSpecialties).toEqual([{ specialtyId: 's', isPrimary: true }]);
    expect(subscription.seatsPsychologistsUsed).toBe(1);
    expect(result).not.toHaveProperty('password');
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });
  it('ASISTENTE without a profile consumes none', async () => {
    await service.create(dto('ASISTENTE', { professionalProfile: undefined }), 'actor');
    expect(subscription.seatsPsychologistsUsed).toBe(0);
  });
  it('inactive profile consumes none', async () => {
    subscription.seatsPsychologistsMax = 0;
    await service.create(
      dto('PROFESIONAL', { professionalProfile: { specialtyId: 's', isActive: false } }),
      'actor',
    );
    expect(subscription.seatsPsychologistsUsed).toBe(0);
  });
  it('rejects the last occupied seat using live count', async () => {
    seed({ role: 'MASTER' });
    subscription.seatsPsychologistsUsed = 0;
    await expect(service.create(dto(), 'actor')).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROFESSIONAL_SEAT_LIMIT_REACHED' },
    });
    expect(users).toHaveLength(1);
  });
  it('normalizes nested, flat, legacy specialty in that order and mirrors title/license', async () => {
    const result = await service.create(
      dto('PROFESIONAL', {
        specialtyId: 'flat',
        specialtyIds: ['legacy'],
        professionalTitle: 'old',
        professionalProfile: {
          specialtyId: 'nested',
          professionalTitle: 'new',
          licenseNumber: 'L',
        },
      }),
      'actor',
    );
    expect(result).toMatchObject({
      professionalTitle: 'new',
      licenseNumber: 'L',
      professionalProfile: { specialtyId: 'nested' },
    });
  });
  it.each([{ specialtyId: 's' }, { specialtyIds: ['s'] }])(
    'accepts flat and legacy specialty input %j',
    async (input) => {
      await service.create(
        dto('PROFESIONAL', { professionalProfile: undefined, ...input }),
        'actor',
      );
      expect(users[0].professionalProfile.specialtyId).toBe('s');
    },
  );
  it('invitation reserves a seat even if the supplied profile is inactive', async () => {
    await service.invite(
      't',
      dto('PROFESIONAL', { professionalProfile: { specialtyId: 's', isActive: false } }),
      'actor',
    );
    expect(users[0]).toMatchObject({ isActive: false, professionalProfile: { isActive: true } });
    expect(subscription.seatsPsychologistsUsed).toBe(1);
    await service.activate('t', users[0].id, 'password', 'actor');
    expect(subscription.seatsPsychologistsUsed).toBe(1);
  });
  it('deactivation releases an invitation reservation despite inactive login', async () => {
    seed({ isActive: false });
    await service.deactivate('t', 'u', 'actor');
    expect(users[0].professionalProfile.isActive).toBe(false);
    expect(subscription.seatsPsychologistsUsed).toBe(0);
  });
  it('provider revoke releases the profile and grant reacquires the seat', async () => {
    seed();
    await service.revokePsychologistAccess('t', 'u');
    expect(subscription.seatsPsychologistsUsed).toBe(0);
    await service.grantPsychologistAccess('t', 'u');
    expect(subscription.seatsPsychologistsUsed).toBe(1);
  });
  it('revoked provider access cannot be restored by general activation or update', async () => {
    seed({ password: 'original', emailVerified: false, activatedAt: null });
    await service.revokePsychologistAccess('t', 'u');
    const revoked = structuredClone(users[0]);
    await expect(service.activate('t', 'u', 'replacement', 'actor')).rejects.toMatchObject({
      status: 403,
    });
    await expect(service.update('t', 'u', { isActive: true }, 'actor')).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.update(
        't',
        'u',
        { professionalProfile: { specialtyId: 's', isActive: true } },
        'actor',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(users[0]).toEqual(revoked);
    expect(subscription.seatsPsychologistsUsed).toBe(0);

    seed({ id: 'other', role: 'PROFESIONAL', managedByProvider: false });
    seed({ id: 'backup-admin', role: 'MASTER', professionalProfile: null });
    await expect(service.grantPsychologistAccess('t', 'u')).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROFESSIONAL_SEAT_LIMIT_REACHED' },
    });
    expect(users[0]).toEqual(revoked);
    await service.deactivate('t', 'other', 'actor');
    await service.grantPsychologistAccess('t', 'u');
    expect(users[0]).toMatchObject({
      isActive: true,
      professionalProfile: { isActive: true },
      password: 'original',
    });
    expect(subscription.seatsPsychologistsUsed).toBe(1);
  });
  it.each([
    { professionalProfile: { specialtyId: 's', isActive: true } },
    { professionalProfile: { specialtyId: 's' } },
    { specialtyId: 's' },
    { specialtyIds: ['s'] },
  ])(
    'rejects creating an active profile on an inactive provider-managed account: %j',
    async (input) => {
      seed({ role: 'MASTER', isActive: false, professionalProfile: null });
      subscription.seatsPsychologistsUsed = 0;
      const inactive = structuredClone(users[0]);
      await expect(service.update('t', 'u', input, 'actor')).rejects.toMatchObject({ status: 403 });
      expect(users[0]).toEqual(inactive);
      expect(subscription.seatsPsychologistsUsed).toBe(0);
    },
  );
  it('allows non-activating edits, inactive profile creation, and removal on an inactive managed account', async () => {
    seed({ role: 'MASTER', isActive: false, professionalProfile: null });
    await service.update(
      't',
      'u',
      { professionalProfile: { specialtyId: 's', isActive: false } },
      'actor',
    );
    await service.update(
      't',
      'u',
      {
        professionalProfile: { specialtyId: 'next', professionalTitle: 'Edited' },
      },
      'actor',
    );
    expect(users[0]).toMatchObject({
      isActive: false,
      professionalProfile: { specialtyId: 'next', professionalTitle: 'Edited', isActive: false },
    });
    expect(subscription.seatsPsychologistsUsed).toBe(0);
    await service.update('t', 'u', { professionalProfile: null }, 'actor');
    expect(users[0]).toMatchObject({
      isActive: false,
      professionalProfile: null,
      professionalTitle: null,
      licenseNumber: null,
      professionalSpecialties: [],
    });
    expect(subscription.seatsPsychologistsUsed).toBe(0);
  });
  it('preserves an active invitation reservation during non-activating edits', async () => {
    seed({ isActive: false });
    await service.update('t', 'u', { professionalTitle: 'Edited' }, 'actor');
    expect(users[0]).toMatchObject({
      isActive: false,
      professionalProfile: { isActive: true, professionalTitle: 'Edited' },
    });
    expect(subscription.seatsPsychologistsUsed).toBe(1);
  });
  it('new invitations remain directly managed and can activate without provider grant', async () => {
    await service.invite('t', dto(), 'actor');
    expect(users[0].managedByProvider).toBe(false);
    await expect(service.grantPsychologistAccess('t', users[0].id)).rejects.toMatchObject({
      status: 400,
    });
    expect(subscription.seatsPsychologistsUsed).toBe(1);
    await service.activate('t', users[0].id, 'password', 'actor');
    expect(users[0].isActive).toBe(true);
    expect(subscription.seatsPsychologistsUsed).toBe(1);
  });
  it('reactivation is rejected when another profile took the seat', async () => {
    seed({
      professionalProfile: { specialtyId: 's', isActive: false },
      isActive: false,
      managedByProvider: false,
    });
    seed({ id: 'other', role: 'MASTER' });
    await expect(service.update('t', 'u', { isActive: true }, 'actor')).rejects.toMatchObject({
      response: { code: 'PROFESSIONAL_SEAT_LIMIT_REACHED' },
    });
    expect(users[0].isActive).toBe(false);
  });
  it('keeps an inactive profile inactive on metadata edits', async () => {
    seed({ professionalProfile: { specialtyId: 's', isActive: false } });
    await service.update('t', 'u', { professionalTitle: 'New' }, 'actor');
    expect(users[0].professionalProfile).toMatchObject({
      professionalTitle: 'New',
      isActive: false,
    });
  });
  it('blocks specialty changes with future appointments before writing either contract', async () => {
    seed();
    db.appointment.count.mockResolvedValue(1);
    await expect(service.update('t', 'u', { specialtyId: 'next' }, 'actor')).rejects.toMatchObject({
      response: { code: 'SPECIALTY_IN_USE' },
    });
    expect(users[0].professionalProfile.specialtyId).toBe('s');
  });
  it('changes specialty in both contracts when no future appointments exist', async () => {
    seed();
    await service.update('t', 'u', { specialtyId: 'next' }, 'actor');
    expect(users[0].professionalProfile.specialtyId).toBe('next');
    expect(users[0].professionalSpecialties).toEqual([{ specialtyId: 'next', isPrimary: true }]);
  });
  it('rejects removing a professional profile', async () => {
    seed();
    await expect(
      service.update('t', 'u', { professionalProfile: null } as any, 'actor'),
    ).rejects.toMatchObject({ status: 422, response: { code: 'PROFESSIONAL_SPECIALTY_REQUIRED' } });
  });
  it('allows admin profile removal and frees its seat', async () => {
    seed({
      role: 'MASTER',
      professionalTitle: 'Clinical title',
      licenseNumber: 'LICENSE-1',
      professionalSpecialties: [{ specialtyId: 's', isPrimary: true }],
    });
    await service.update('t', 'u', { professionalProfile: null } as any, 'actor');
    expect(users[0].professionalProfile).toBeNull();
    expect(users[0].professionalSpecialties).toEqual([]);
    expect(users[0].professionalTitle).toBeNull();
    expect(users[0].licenseNumber).toBeNull();
    expect(subscription.seatsPsychologistsUsed).toBe(0);
  });
  it('retries serialization conflicts twice and exposes the functional conflict', async () => {
    db.$transaction.mockRejectedValue({ code: 'P2034' });
    await expect(service.create(dto(), 'actor')).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROFESSIONAL_SEAT_LIMIT_REACHED' },
    });
    expect(db.$transaction).toHaveBeenCalledTimes(3);
  });
  it('retries a serialization conflict against the new live count', async () => {
    db.$transaction.mockImplementationOnce(async () => {
      seed();
      throw { code: 'P2034' };
    });
    await expect(service.create(dto(), 'actor')).rejects.toMatchObject({
      response: { code: 'PROFESSIONAL_SEAT_LIMIT_REACHED' },
    });
    expect(users).toHaveLength(1);
  });
  it.each(['MASTER', 'PROFESIONAL'])('filters %s by the exact role', async (role) => {
    await service.findAll('t', { role });
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 't', role },
        select: expect.objectContaining({
          professionalProfile: { include: { specialty: true } },
          professionalTitle: true,
          licenseNumber: true,
          professionalSpecialties: expect.anything(),
        }),
      }),
    );
  });
  it('update validation excludes tenant and password and rejects multiple legacy specialties', async () => {
    const update = plainToInstance(UpdateUserDto, {
      tenantId: 'other',
      password: 'p',
      specialtyIds: ['a', 'b'],
    });
    const errors = await validate(update, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['tenantId', 'password', 'specialtyIds']),
    );
  });
});

// Opt in only on the explicitly disposable database; no shared database cleanup.
const integration = process.env.PROFILE_SEATS_INTEGRATION === '1' ? describe : describe.skip;
integration('Users - PostgreSQL serializable seat race', () => {
  let prisma: PrismaService;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (url.pathname !== '/psic_clinic_profile_seats_test')
      throw new Error('Expected dedicated profile seat test database');
    prisma = new PrismaService(new RlsContextService());
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('allows exactly one of two concurrent requests to take the final seat', async () => {
    const specialty = await prisma.specialty.create({
      data: { code: 'RACE-' + Date.now(), name: 'Race fixture' },
    });
    const tenant = await prisma.tenant.create({
      data: {
        name: 'Seat race fixture',
        email: 'race@test.invalid',
        tenantType: 'CLINIC',
        subscription: {
          create: { planId: 'plan_clinic_basic', status: 'ACTIVE', seatsPsychologistsMax: 1 },
        },
        specialties: { create: { specialtyId: specialty.id } },
      },
    });
    const profiles = new ProfessionalProfilesService(prisma);
    // Barrier after both live reads forces a real serialization conflict at commit.
    const original = profiles.assertSeatAvailable.bind(profiles);
    let arrivals = 0;
    let release: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(profiles, 'assertSeatAvailable').mockImplementation(async (tenantId, tx) => {
      await original(tenantId, tx);
      arrivals++;
      if (arrivals === 2) release();
      if (arrivals <= 2) await barrier;
    });
    const service = new UsersService(
      prisma,
      { hashPassword: async () => 'hash' } as unknown as AuthService,
      profiles,
      {} as PatientTeamService,
      { sendInvitation: jest.fn().mockResolvedValue(true) } as unknown as MailService,
    );
    const results = await Promise.allSettled(
      ['a', 'b'].map((email) =>
        service.create(
          {
            tenantId: tenant.id,
            email: email + '@test.invalid',
            firstName: 'Race',
            lastName: email,
            role: 'PROFESIONAL',
            professionalProfile: { specialtyId: specialty.id },
          },
          'fixture-actor',
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { response: { code: 'PROFESSIONAL_SEAT_LIMIT_REACHED' } },
    });
    expect(await profiles.countActiveProfiles(tenant.id)).toBe(1);
    expect(
      await prisma.tenantSubscription.findUnique({ where: { tenantId: tenant.id } }),
    ).toMatchObject({ seatsPsychologistsUsed: 1 });
    const winner = await prisma.user.findFirstOrThrow({
      where: { tenantId: tenant.id },
      include: {
        professionalProfile: { include: { specialty: true } },
        professionalSpecialties: true,
      },
    });
    expect(winner.professionalProfile?.specialty.id).toBe(specialty.id);
    expect(winner.professionalSpecialties).toHaveLength(1);
    await service.deactivate(tenant.id, winner.id, 'actor');
    expect(await profiles.countActiveProfiles(tenant.id)).toBe(0);
    await service.update(tenant.id, winner.id, { isActive: true }, 'actor');
    expect(await profiles.countActiveProfiles(tenant.id)).toBe(1);
  }, 20000);
});
