import { MailService } from '../mail/mail.service';
import { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { ProfessionalProfilesService } from '../professional-profiles/professional-profiles.service';
import { PatientTeamService } from '../patient-team/patient-team.service';

describe('UsersService clinic team control', () => {
  let service: UsersService;
  let db: any;
  let users: any[];
  let tenant: any;
  let subscription: any;
  let assignments: { tenantId: string; professionalId: string; isActive: boolean }[];
  let patientTeam: {
    assertNoFutureAppointmentsForProfessional: jest.Mock;
    deactivateAllForProfessional: jest.Mock;
  };
  let operations: string[];
  const member = (extra: Record<string, unknown> = {}) => ({
    email: ' Member@Example.COM ',
    password: 'Password123!',
    firstName: 'Ana',
    lastName: 'Vega',
    role: 'ASISTENTE',
    ...extra,
  });
  const professional = (extra: Record<string, unknown> = {}) =>
    member({ role: 'PROFESIONAL', professionalProfile: { specialtyId: 'specialty-1' }, ...extra });
  const seed = (extra: Record<string, unknown> = {}) => {
    const user = {
      id: `user-${users.length + 1}`,
      tenantId: 'tenant-1',
      email: `existing-${users.length + 1}@example.com`,
      role: 'MASTER',
      isActive: true,
      managedByProvider: false,
      password: 'seed-hash',
      professionalProfile: null,
      ...extra,
    };
    users.push(user);
    return user;
  };

  beforeEach(() => {
    users = [];
    assignments = [];
    operations = [];
    tenant = { id: 'tenant-1', tenantType: 'CLINIC' };
    subscription = {
      tenantId: 'tenant-1',
      planType: 'TRIAL',
      status: 'TRIALING',
      seatsPsychologistsMax: 1,
      seatsPsychologistsUsed: 0,
    };
    db = {
      applyRlsContext: jest.fn(),
      $transaction: jest.fn(async (operation) => operation(db)),
      tenant: { findUnique: jest.fn(async () => tenant) },
      tenantSubscription: {
        findUnique: jest.fn(async () => subscription),
        update: jest.fn(async ({ data }) => {
          operations.push('subscription.update');
          return Object.assign(subscription, data);
        }),
      },
      tenantSpecialty: {
        findUnique: jest.fn(async ({ where }) =>
          where.tenantId_specialtyId.specialtyId === 'specialty-1'
            ? { tenantId: 'tenant-1', specialtyId: 'specialty-1' }
            : null,
        ),
      },
      professionalProfile: {
        count: jest.fn(
          async () =>
            users.filter((u) => u.tenantId === 'tenant-1' && u.professionalProfile?.isActive)
              .length,
        ),
        findUnique: jest.fn(
          async ({ where }) =>
            users.find((u) => u.id === where.userId)?.professionalProfile ?? null,
        ),
      },
      appointment: { count: jest.fn().mockResolvedValue(0) },
      user: {
        findUnique: jest.fn(
          async ({ where }) =>
            users.find(
              (u) =>
                u.tenantId === where.tenantId_email.tenantId &&
                u.email === where.tenantId_email.email,
            ) ?? null,
        ),
        findFirst: jest.fn(async ({ where }) => {
          if (typeof where.id === 'string')
            return users.find((u) => u.id === where.id && u.tenantId === where.tenantId) ?? null;
          const email = typeof where.email === 'string' ? where.email : where.email?.equals;
          return (
            users.find(
              (u) =>
                u.tenantId === where.tenantId &&
                u.id !== where.id?.not &&
                u.email.toLowerCase() === email?.toLowerCase(),
            ) ?? null
          );
        }),
        create: jest.fn(async ({ data }) => {
          const user = {
            ...data,
            id: `user-${users.length + 1}`,
            professionalProfile: data.professionalProfile?.create ?? null,
            professionalSpecialties: data.professionalSpecialties?.create
              ? [data.professionalSpecialties.create]
              : [],
          };
          users.push(user);
          return user;
        }),
        update: jest.fn(async ({ where, data }) => {
          operations.push('user.update');
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
          if (professionalSpecialties)
            user.professionalSpecialties = professionalSpecialties.create
              ? [professionalSpecialties.create]
              : [];
          return user;
        }),
      },
    };
    patientTeam = {
      assertNoFutureAppointmentsForProfessional: jest.fn(async () => {
        operations.push('appointment.guard');
      }),
      deactivateAllForProfessional: jest.fn(async (tx, tenantId, professionalId) => {
        operations.push('team.deactivate');
        let count = 0;
        for (const assignment of assignments) {
          if (
            assignment.tenantId === tenantId &&
            assignment.professionalId === professionalId &&
            assignment.isActive
          ) {
            assignment.isActive = false;
            count++;
          }
        }
        return count;
      }),
    };
    service = new UsersService(
      db as PrismaService,
      { hashPassword: jest.fn().mockResolvedValue('secure-hash') } as unknown as AuthService,
      new ProfessionalProfilesService(db as PrismaService),
      patientTeam as unknown as PatientTeamService,
      { sendInvitation: jest.fn().mockResolvedValue(true) } as unknown as MailService,
    );
  });

  it.each(['SOPORTE', 'PACIENTE', 'UNKNOWN'])('rejects tenant-created role %s', async (role) => {
    await expect(
      service.createForTenant('tenant-1', member({ role }) as any, 'admin-1'),
    ).rejects.toMatchObject({ status: 400, response: { code: 'ROLE_NOT_ASSIGNABLE' } });
    expect(users).toHaveLength(0);
  });

  it.each([
    ['PERSONAL', 'TRIALING'],
    ['CLINIC', 'CANCELED'],
    ['CLINIC', 'PAST_DUE'],
  ])('rejects team creation for %s tenant with %s subscription', async (tenantType, status) => {
    tenant.tenantType = tenantType;
    subscription.status = status;
    await expect(
      service.createForTenant('tenant-1', member() as any, 'admin-1'),
    ).rejects.toMatchObject({ status: 403, response: { code: 'TEAM_NOT_AVAILABLE' } });
    expect(users).toHaveLength(0);
  });

  it('creates a direct active account in a CLINIC trial without leaking credentials', async () => {
    const result = await service.createForTenant('tenant-1', member() as any, 'admin-1');
    expect(result).toMatchObject({
      email: 'member@example.com',
      isActive: true,
      managedByProvider: false,
      emailVerified: true,
    });
    expect(result).not.toHaveProperty('password');
    expect(users[0]).toMatchObject({
      password: 'secure-hash',
      activatedAt: expect.any(Date),
      invitedAt: undefined,
    });
    expect(db.applyRlsContext).toHaveBeenCalledWith(db, {
      tenantId: 'tenant-1',
      userId: 'admin-1',
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it.each(['PROFESIONAL', 'ASISTENTE'])('accepts compatible team role %s', async (role) => {
    const input = role === 'PROFESIONAL' ? professional({ role }) : member({ role });
    await service.createForTenant('tenant-1', input as any, 'admin-1');
    expect(users[0].role).toBe(role);
    expect(users[0].managedByProvider).toBe(false);
  });

  it('requires a specialty for a professional and rejects an assistant profile', async () => {
    await expect(
      service.createForTenant('tenant-1', member({ role: 'PROFESIONAL' }) as any, 'admin-1'),
    ).rejects.toMatchObject({ response: { code: 'PROFESSIONAL_SPECIALTY_REQUIRED' } });
    await expect(
      service.createForTenant(
        'tenant-1',
        member({ professionalProfile: { specialtyId: 'specialty-1' } }) as any,
        'admin-1',
      ),
    ).rejects.toMatchObject({ response: { code: 'PROFESSIONAL_PROFILE_NOT_ALLOWED' } });
  });

  it('allows an assistant without a seat and a professional with one mirrored specialty', async () => {
    await service.createForTenant('tenant-1', member({ role: 'ASISTENTE' }) as any, 'admin-1');
    expect(subscription.seatsPsychologistsUsed).toBe(0);
    const result = await service.createForTenant(
      'tenant-1',
      professional({ email: 'clinical@example.com' }) as any,
      'admin-1',
    );
    expect(result.professionalProfile).toMatchObject({ specialtyId: 'specialty-1' });
    expect(users[1].professionalSpecialties).toEqual([
      { specialtyId: 'specialty-1', isPrimary: true },
    ]);
    expect(subscription.seatsPsychologistsUsed).toBe(1);
  });

  it('rejects a specialty outside the tenant and an occupied seat before creating', async () => {
    await expect(
      service.createForTenant(
        'tenant-1',
        professional({ professionalProfile: { specialtyId: 'other' } }) as any,
        'admin-1',
      ),
    ).rejects.toMatchObject({ response: { code: 'SPECIALTY_NOT_ENABLED' } });
    seed({ professionalProfile: { specialtyId: 'specialty-1', isActive: true } });
    await expect(
      service.createForTenant('tenant-1', professional() as any, 'admin-1'),
    ).rejects.toMatchObject({ response: { code: 'PROFESSIONAL_SEAT_LIMIT_REACHED' } });
    expect(users).toHaveLength(1);
  });

  it('normalizes email and conflicts with mixed-case legacy email in the same tenant', async () => {
    seed({ email: 'MEMBER@example.com' });
    await expect(
      service.createForTenant('tenant-1', member() as any, 'admin-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(users).toHaveLength(1);
  });

  it('returns the same tenant conflict when a concurrent create wins the email unique constraint', async () => {
    db.user.create.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['tenantId', 'email'] },
    });
    await expect(
      service.createForTenant('tenant-1', member() as any, 'admin-1'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not send an invitation during direct creation', async () => {
    const previous = process.env.EMAIL_API_URL;
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    process.env.EMAIL_API_URL = 'https://mail.example.test/send';
    try {
      await service.createForTenant('tenant-1', member() as any, 'admin-1');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (previous === undefined) delete process.env.EMAIL_API_URL;
      else process.env.EMAIL_API_URL = previous;
    }
  });

  it('keeps the legacy create wrapper internal and delegates without tenantId in body', async () => {
    const result = await service.create({ tenantId: 'tenant-1', ...member() } as any, 'admin-1');
    expect(result.email).toBe('member@example.com');
    expect(users[0].tenantId).toBe('tenant-1');
  });

  it('blocks self deactivation before any write', async () => {
    seed({ id: 'admin-1' });
    const self = seed({ id: 'assistant-1', role: 'ASISTENTE' });
    await expect(service.deactivate('tenant-1', self.id, self.id)).rejects.toMatchObject({
      response: { code: 'CANNOT_DEACTIVATE_SELF' },
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it.each(['SOPORTE', 'PACIENTE'])('rejects changing a team member to %s', async (role) => {
    seed({ id: 'admin-1' });
    seed({ id: 'assistant-1', role: 'ASISTENTE' });
    await expect(
      service.update('tenant-1', 'assistant-1', { role: role as any }, 'admin-1'),
    ).rejects.toMatchObject({ status: 400, response: { code: 'ROLE_NOT_ASSIGNABLE' } });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('allows removal of a non-master member', async () => {
    seed({ id: 'admin-1', role: 'MASTER' });
    seed({ id: 'admin-2', role: 'ASISTENTE' });
    await service.deactivate('tenant-1', 'admin-2', 'admin-1');
    expect(users[1].isActive).toBe(false);
  });

  it('normalizes edited email and rejects a mixed-case conflict within the tenant', async () => {
    seed({ id: 'admin-1' });
    const target = seed({ id: 'assistant-1', role: 'ASISTENTE' });
    seed({ id: 'other-user', role: 'ASISTENTE', email: 'TAKEN@EXAMPLE.COM' });
    await expect(
      service.update('tenant-1', target.id, { email: ' Taken@example.com ' }, 'admin-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.user.update).not.toHaveBeenCalled();
    await service.update('tenant-1', target.id, { email: ' NEW@Example.COM ' }, 'admin-1');
    expect(target.email).toBe('new@example.com');
  });

  it('returns a tenant conflict if a concurrent email edit wins the unique constraint', async () => {
    seed({ id: 'admin-1' });
    seed({ id: 'assistant-1', role: 'ASISTENTE' });
    db.user.update.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['tenantId', 'email'] },
    });
    await expect(
      service.update('tenant-1', 'assistant-1', { email: 'new@example.com' }, 'admin-1'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('deactivating a direct professional twice leaves the occupied seat at zero', async () => {
    seed({ id: 'admin-1', professionalProfile: null });
    seed({
      id: 'professional-1',
      role: 'PROFESIONAL',
      professionalProfile: { specialtyId: 'specialty-1', isActive: true },
    });
    await service.deactivate('tenant-1', 'professional-1', 'admin-1');
    await service.deactivate('tenant-1', 'professional-1', 'admin-1');
    expect(subscription.seatsPsychologistsUsed).toBe(0);
  });

  it.each([
    ['PROFESIONAL', { isActive: false }, false, false],
    [
      'PROFESIONAL',
      { professionalProfile: { specialtyId: 'specialty-1', isActive: false } },
      true,
      false,
    ],
    ['MASTER', { professionalProfile: null }, true, null],
    ['PROFESIONAL', { role: 'ASISTENTE' }, true, null],
  ])(
    'deactivates treating assignments after %s loses clinical capacity through %j',
    async (role, change, expectedAccountActive, expectedProfileActive) => {
      seed({ id: 'admin-1' });
      const target = seed({
        id: 'professional-1',
        role,
        professionalProfile: { specialtyId: 'specialty-1', isActive: true },
      });
      assignments.push(
        { tenantId: 'tenant-1', professionalId: 'professional-1', isActive: true },
        { tenantId: 'tenant-1', professionalId: 'professional-1', isActive: false },
        { tenantId: 'tenant-2', professionalId: 'professional-1', isActive: true },
        { tenantId: 'tenant-1', professionalId: 'another-professional', isActive: true },
      );

      await service.update('tenant-1', target.id, change as any, 'admin-1');

      expect(target.isActive).toBe(expectedAccountActive);
      expect(target.professionalProfile?.isActive ?? null).toBe(expectedProfileActive);
      expect(assignments.map((row) => row.isActive)).toEqual([false, false, true, true]);
      expect(patientTeam.assertNoFutureAppointmentsForProfessional).toHaveBeenCalledWith(
        db,
        'tenant-1',
        target.id,
      );
      expect(patientTeam.deactivateAllForProfessional).toHaveBeenCalledWith(
        db,
        'tenant-1',
        target.id,
      );
      expect(operations.indexOf('appointment.guard')).toBeLessThan(
        operations.indexOf('user.update'),
      );
      expect(operations.indexOf('user.update')).toBeLessThan(operations.indexOf('team.deactivate'));
    },
  );

  it('preserves the future appointment conflict and leaves user, profile, seats, and team untouched', async () => {
    seed({ id: 'admin-1' });
    const target = seed({
      id: 'professional-1',
      role: 'PROFESIONAL',
      professionalProfile: { specialtyId: 'specialty-1', isActive: true },
    });
    assignments.push({ tenantId: 'tenant-1', professionalId: target.id, isActive: true });
    const conflict = new ConflictException({
      statusCode: 409,
      code: 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS',
      message: 'Cancela o reasigna las citas futuras.',
      details: { appointments: [{ id: 'appointment-1', patientId: 'patient-1' }] },
    });
    patientTeam.assertNoFutureAppointmentsForProfessional.mockRejectedValue(conflict);

    await expect(
      service.update(
        'tenant-1',
        target.id,
        { professionalProfile: { specialtyId: 'specialty-1', isActive: false } },
        'admin-1',
      ),
    ).rejects.toBe(conflict);

    expect(operations).toEqual([]);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.tenantSubscription.update).not.toHaveBeenCalled();
    expect(patientTeam.deactivateAllForProfessional).not.toHaveBeenCalled();
    expect(target.professionalProfile.isActive).toBe(true);
    expect(assignments[0].isActive).toBe(true);
  });

  it('checks future appointments before specialty validation on a combined deactivation edit', async () => {
    seed({ id: 'admin-1' });
    const target = seed({
      id: 'professional-1',
      role: 'PROFESIONAL',
      professionalProfile: { specialtyId: 'specialty-1', isActive: true },
    });
    const conflict = new ConflictException({
      statusCode: 409,
      code: 'PROFESSIONAL_HAS_FUTURE_APPOINTMENTS',
      details: { appointments: [{ id: 'appointment-1' }] },
    });
    patientTeam.assertNoFutureAppointmentsForProfessional.mockRejectedValue(conflict);

    await expect(
      service.update(
        'tenant-1',
        target.id,
        { professionalProfile: { specialtyId: 'disabled-specialty', isActive: false } },
        'admin-1',
      ),
    ).rejects.toBe(conflict);

    expect(db.tenantSpecialty.findUnique).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('does not reactivate historical assignments when clinical capacity returns', async () => {
    seed({ id: 'admin-1' });
    const target = seed({
      id: 'professional-1',
      role: 'PROFESIONAL',
      isActive: false,
      professionalProfile: { specialtyId: 'specialty-1', isActive: false },
    });
    assignments.push({ tenantId: 'tenant-1', professionalId: target.id, isActive: false });

    await service.update('tenant-1', target.id, { isActive: true }, 'admin-1');

    expect(target.isActive).toBe(true);
    expect(target.professionalProfile.isActive).toBe(true);
    expect(assignments[0].isActive).toBe(false);
    expect(patientTeam.assertNoFutureAppointmentsForProfessional).not.toHaveBeenCalled();
    expect(patientTeam.deactivateAllForProfessional).not.toHaveBeenCalled();
  });

  it('does not guard or deactivate assignments for metadata edits with omitted activity', async () => {
    seed({ id: 'admin-1' });
    const target = seed({
      id: 'professional-1',
      role: 'MASTER',
      professionalProfile: { specialtyId: 'specialty-1', isActive: true },
    });
    assignments.push({ tenantId: 'tenant-1', professionalId: target.id, isActive: true });

    await service.update('tenant-1', target.id, { firstName: 'Updated' }, 'admin-1');

    expect(assignments[0].isActive).toBe(true);
    expect(patientTeam.assertNoFutureAppointmentsForProfessional).not.toHaveBeenCalled();
    expect(patientTeam.deactivateAllForProfessional).not.toHaveBeenCalled();
  });

  it('does not reactivate a clinical profile while its direct account stays inactive', async () => {
    seed({ id: 'admin-1', professionalProfile: null });
    seed({
      id: 'professional-1',
      role: 'PROFESIONAL',
      isActive: false,
      professionalProfile: { specialtyId: 'specialty-1', isActive: false },
    });
    await expect(
      service.update(
        'tenant-1',
        'professional-1',
        {
          professionalProfile: { specialtyId: 'specialty-1', isActive: true },
        },
        'admin-1',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(subscription.seatsPsychologistsUsed).toBe(0);
  });

  it('keeps provider grant and revoke limited to preexisting legacy managed rows', async () => {
    seed({
      id: 'direct-user',
      role: 'PROFESIONAL',
      managedByProvider: false,
      professionalProfile: { specialtyId: 'specialty-1', isActive: false },
    });
    await expect(service.revokePsychologistAccess('tenant-1', 'direct-user')).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(service.grantPsychologistAccess('tenant-1', 'direct-user')).rejects.toMatchObject({
      status: 400,
    });
    expect(db.user.update).not.toHaveBeenCalled();
    seed({
      id: 'legacy-user',
      role: 'PROFESIONAL',
      managedByProvider: true,
      isActive: false,
      professionalProfile: { specialtyId: 'specialty-1', isActive: false },
    });
    await service.grantPsychologistAccess('tenant-1', 'legacy-user');
    expect(users[1].isActive).toBe(true);
  });

  it.each([
    [
      'active direct account',
      { isActive: true, invitedAt: null, activatedAt: new Date('2026-01-01') },
    ],
    [
      'ordinary deactivated account',
      { isActive: false, invitedAt: null, activatedAt: new Date('2026-01-01') },
    ],
    [
      'already activated invitation',
      { isActive: false, invitedAt: new Date('2026-01-01'), activatedAt: new Date('2026-01-02') },
    ],
  ])('refuses activation for %s without changing its password', async (_case, state) => {
    const target = seed({ id: 'target-1', role: 'ASISTENTE', password: 'original-hash', ...state });
    await expect(
      service.activate('tenant-1', target.id, 'Password123!', 'admin-1'),
    ).rejects.toMatchObject({ status: 409, response: { code: 'ACTIVATION_NOT_PENDING' } });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(target.password).toBe('original-hash');
  });

  it('activates a pending invitation once under actor RLS and does not return the hash', async () => {
    const target = seed({
      id: 'pending-1',
      role: 'ASISTENTE',
      isActive: false,
      invitedAt: new Date('2026-01-01'),
      activatedAt: null,
      emailVerified: false,
      password: 'old-hash',
    });
    const result = await service.activate('tenant-1', target.id, 'Password123!', 'admin-1');
    expect(target).toMatchObject({
      isActive: true,
      emailVerified: true,
      password: 'secure-hash',
      activatedAt: expect.any(Date),
    });
    expect(result).not.toHaveProperty('password');
    expect(db.applyRlsContext).toHaveBeenCalledWith(db, {
      tenantId: 'tenant-1',
      userId: 'admin-1',
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    db.user.update.mockClear();
    await expect(
      service.activate('tenant-1', target.id, 'AnotherPassword123!', 'admin-1'),
    ).rejects.toMatchObject({ response: { code: 'ACTIVATION_NOT_PENDING' } });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(target.password).toBe('secure-hash');
  });

  it('cannot activate a pending invitation belonging to another tenant', async () => {
    seed({
      id: 'pending-other',
      tenantId: 'tenant-2',
      role: 'ASISTENTE',
      isActive: false,
      invitedAt: new Date('2026-01-01'),
      activatedAt: null,
    });
    await expect(
      service.activate('tenant-1', 'pending-other', 'Password123!', 'admin-1'),
    ).rejects.toMatchObject({ status: 404 });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  describe('account holder rules', () => {
    it.each(['MASTER', 'ADMIN', 'CLIENTE', 'PSICOLOGO', 'SOPORTE', 'PACIENTE'])(
      'rejects creating a %s member',
      async (role) => {
        seed({ role: 'MASTER' });
        await expect(
          service.createForTenant('tenant-1', member({ role }) as never, 'user-1'),
        ).rejects.toMatchObject({ response: { code: 'ROLE_NOT_ASSIGNABLE' } });
        expect(users).toHaveLength(1);
      },
    );

    it.each(['MASTER', 'ADMIN', 'CLIENTE', 'PSICOLOGO'])(
      'rejects changing an assistant to %s',
      async (role) => {
        seed({ role: 'MASTER' });
        const assistant = seed({ role: 'ASISTENTE' });
        await expect(
          service.update('tenant-1', assistant.id, { role } as never, 'user-1'),
        ).rejects.toMatchObject({ response: { code: 'ROLE_NOT_ASSIGNABLE' } });
        expect(assistant.role).toBe('ASISTENTE');
      },
    );

    it.each(['PROFESIONAL', 'ASISTENTE'])('rejects changing the master to %s', async (role) => {
      const master = seed({ role: 'MASTER' });
      seed({ role: 'ASISTENTE' });
      await expect(
        service.update('tenant-1', master.id, { role } as never, 'user-2'),
      ).rejects.toMatchObject({ response: { code: 'MASTER_IMMUTABLE' } });
      expect(master.role).toBe('MASTER');
    });

    it('rejects deactivating the master, by the master or by anyone else in the clinic', async () => {
      const master = seed({ role: 'MASTER' });
      await expect(service.deactivate('tenant-1', master.id, master.id)).rejects.toMatchObject({
        response: { code: 'MASTER_IMMUTABLE' },
      });
      await expect(service.deactivate('tenant-1', master.id, 'someone-else')).rejects.toMatchObject(
        {
          response: { code: 'MASTER_IMMUTABLE' },
        },
      );
      expect(master.isActive).toBe(true);
    });

    // The team form always sends the current role back, even when only the name changed.
    it('lets the master edit personal data while resending the unchanged MASTER role', async () => {
      const master = seed({ role: 'MASTER' });
      await expect(
        service.update(
          'tenant-1',
          master.id,
          { role: 'MASTER', firstName: 'Nuevo' } as never,
          master.id,
        ),
      ).resolves.toBeDefined();
    });

    // The data migration leaves surplus administrators as PROFESIONAL without a profile.
    it('deactivates and edits a profile-less professional', async () => {
      seed({ role: 'MASTER' });
      const orphan = seed({ role: 'PROFESIONAL', professionalProfile: null });
      await expect(
        service.update('tenant-1', orphan.id, { firstName: 'Nuevo' } as never, 'user-1'),
      ).resolves.toBeDefined();
      expect((orphan as Record<string, unknown>).firstName).toBe('Nuevo');
      await expect(service.deactivate('tenant-1', orphan.id, 'user-1')).resolves.toBeDefined();
      expect(orphan.isActive).toBe(false);
    });

    it('still requires a profile when changing an assistant to professional', async () => {
      seed({ role: 'MASTER' });
      const assistant = seed({ role: 'ASISTENTE' });
      await expect(
        service.update('tenant-1', assistant.id, { role: 'PROFESIONAL' } as never, 'user-1'),
      ).rejects.toMatchObject({ response: { code: 'PROFESSIONAL_SPECIALTY_REQUIRED' } });
      expect(assistant.role).toBe('ASISTENTE');
    });

    // Provider-managed access is granted and revoked by support, outside the clinic's team rules.
    it('lets the provider flow revoke access of a provider-managed master', async () => {
      const master = seed({ role: 'MASTER', managedByProvider: true });
      await expect(service.revokePsychologistAccess('tenant-1', master.id)).resolves.toEqual({
        message: 'Acceso del usuario revocado exitosamente',
      });
    });
  });
});
