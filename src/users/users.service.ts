import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, TenantType, UserRole } from '@prisma/client';
import { CreateTenantUserDto, CreateUserDto, InviteUserDto, UpdateUserDto } from './dto/user.dto';
import { AuthService } from '../auth/auth.service';
import { isMasterRole, isProfessionalRole } from '../common/roles/role-compatibility';
import { ProfessionalProfilesService } from '../professional-profiles/professional-profiles.service';
import { ProfessionalProfileInputDto } from '../professional-profiles/dto/professional-profile.dto';
import { UpdateSelfProfileDto } from './dto/update-self-profile.dto';
import { PatientTeamService } from '../patient-team/patient-team.service';

const professionalFields = {
  professionalTitle: true,
  licenseNumber: true,
  professionalSpecialties: { include: { specialty: true } },
  professionalProfile: { include: { specialty: true } },
} satisfies Prisma.UserSelect;

const userSelect = {
  id: true,
  tenantId: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  avatarUrl: true,
  role: true,
  isActive: true,
  managedByProvider: true,
  emailVerified: true,
  invitedAt: true,
  activatedAt: true,
  createdAt: true,
  updatedAt: true,
  ...professionalFields,
} satisfies Prisma.UserSelect;

const selfUserSelect = {
  id: true,
  tenantId: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  avatarUrl: true,
  role: true,
  isActive: true,
  professionalTitle: true,
  licenseNumber: true,
  professionalProfile: { include: { specialty: true } },
} satisfies Prisma.UserSelect;

const ASSIGNABLE_TEAM_ROLES: readonly UserRole[] = [UserRole.PROFESIONAL, UserRole.ASISTENTE];

const roleNotAssignable = () =>
  new BadRequestException({
    statusCode: 400,
    code: 'ROLE_NOT_ASSIGNABLE',
    message: 'Solo se pueden asignar los roles Profesional o Asistente.',
  });

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private profiles: ProfessionalProfilesService,
    private patientTeam: PatientTeamService,
    private mail: MailService,
  ) {}

  private resolveProfileInput(
    dto: CreateTenantUserDto | InviteUserDto | UpdateUserDto,
  ): ProfessionalProfileInputDto | undefined {
    const specialtyId =
      dto.professionalProfile?.specialtyId ?? dto.specialtyId ?? dto.specialtyIds?.[0];
    if (!specialtyId) return undefined;
    return {
      specialtyId,
      professionalTitle: dto.professionalProfile?.professionalTitle ?? dto.professionalTitle,
      licenseNumber: dto.professionalProfile?.licenseNumber ?? dto.licenseNumber,
      bio: dto.professionalProfile?.bio,
      isActive: dto.professionalProfile?.isActive ?? true,
    };
  }

  private async mutate<T>(
    tenantId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    userId?: string,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await this.prisma.applyRlsContext(tx, { tenantId, userId });
            return operation(tx);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2034') throw error;
        if (attempt >= 2) {
          throw new ConflictException({
            statusCode: 409,
            code: 'PROFESSIONAL_SEAT_LIMIT_REACHED',
            message: 'Se alcanzó el límite de profesionales activos del plan.',
          });
        }
      }
    }
  }

  async create(dto: CreateUserDto, createdBy: string) {
    const { tenantId, ...tenantDto } = dto;
    return this.createForTenant(tenantId, tenantDto as CreateTenantUserDto, createdBy);
  }

  async createForTenant(tenantId: string, dto: CreateTenantUserDto, actorId: string) {
    return this.createOrInvite(tenantId, dto, actorId, false);
  }

  async invite(tenantId: string, dto: InviteUserDto, invitedBy: string) {
    const user = await this.createOrInvite(tenantId, dto, invitedBy, true);
    await this.sendInvitationEmail(tenantId, user);
    return user;
  }

  private async createOrInvite(
    tenantId: string,
    dto: CreateTenantUserDto | InviteUserDto,
    actorId: string,
    invitation: boolean,
  ) {
    const { role } = dto;
    if (!ASSIGNABLE_TEAM_ROLES.includes(role)) throw roleNotAssignable();
    if (dto.specialtyIds && dto.specialtyIds.length > 1) {
      throw new BadRequestException({
        code: 'PROFESSIONAL_SPECIALTY_REQUIRED',
        message: 'El profesional debe tener exactamente una especialidad.',
      });
    }
    const password = 'password' in dto ? dto.password : undefined;
    if (!invitation && !password) {
      throw new BadRequestException({
        code: 'INITIAL_PASSWORD_REQUIRED',
        message: 'La contraseña inicial es obligatoria.',
      });
    }
    const email = dto.email.trim().toLowerCase();
    const profile = this.resolveProfileInput(dto);
    if (invitation && profile) profile.isActive = true;
    this.profiles.validateRoleProfile(role, profile);
    const hashedPassword = await this.authService.hashPassword(
      password ?? Math.random().toString(36).slice(-12),
    );

    try {
      return await this.mutate(
        tenantId,
        async (tx) => {
          await this.ensureClinicTeam(tenantId, tx);
          const existing = await tx.user.findFirst({
            where: { tenantId, email: { equals: email, mode: 'insensitive' } },
          });
          if (existing)
            throw new ConflictException('Este email ya está registrado en esta clínica');
          if (profile) {
            await this.profiles.assertSpecialtyEnabled(tenantId, profile.specialtyId, tx);
            if (profile.isActive) await this.checkSeatAvailability(tenantId, tx);
          }
          const user = await tx.user.create({
            data: {
              tenantId,
              email,
              password: hashedPassword,
              firstName: dto.firstName,
              lastName: dto.lastName,
              phone: dto.phone,
              role,
              professionalTitle: profile?.professionalTitle ?? dto.professionalTitle,
              licenseNumber: profile?.licenseNumber ?? dto.licenseNumber,
              professionalProfile: profile ? { create: profile } : undefined,
              professionalSpecialties: profile
                ? { create: { specialtyId: profile.specialtyId, isPrimary: true } }
                : undefined,
              isActive: !invitation,
              managedByProvider: false,
              emailVerified: !invitation && !!password,
              activatedAt: !invitation ? new Date() : null,
              invitedAt: invitation ? new Date() : undefined,
              invitedBy: invitation ? actorId : undefined,
            },
            select: userSelect,
          });
          await this.profiles.syncStoredSeatCount(tenantId, tx);
          // Strip defensively for adapters that return extra fields.
          const { password: _, ...safe } = user as typeof user & { password?: string };
          return safe;
        },
        actorId,
      );
    } catch (error) {
      const prismaError = error as { code?: string; meta?: { target?: string[] } };
      if (prismaError.code === 'P2002' && prismaError.meta?.target?.includes('email')) {
        throw new ConflictException('Este email ya está registrado en esta clínica');
      }
      throw error;
    }
  }

  private async ensureClinicTeam(tenantId: string, tx: Prisma.TransactionClient) {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    const subscription = await tx.tenantSubscription.findUnique({ where: { tenantId } });
    if (
      tenant?.tenantType !== TenantType.CLINIC ||
      !subscription ||
      (subscription.status !== 'ACTIVE' && subscription.status !== 'TRIALING')
    ) {
      throw new ForbiddenException({
        code: 'TEAM_NOT_AVAILABLE',
        message: 'La administración de equipo no está disponible para este consultorio.',
      });
    }
  }

  private async checkSeatAvailability(tenantId: string, tx: Prisma.TransactionClient) {
    await this.profiles.assertSeatAvailable(tenantId, tx);
    const subscription = await tx.tenantSubscription.findUnique({ where: { tenantId } });
    if (subscription && subscription.status !== 'ACTIVE' && subscription.status !== 'TRIALING') {
      throw new ForbiddenException({
        error: 'SUBSCRIPTION_INACTIVE',
        message: 'No se pueden invitar usuarios. Tu suscripción no está activa.',
        status: subscription.status,
      });
    }
  }

  async findAll(tenantId: string, filters?: { role?: string; isActive?: boolean }) {
    const where: Prisma.UserWhereInput = { tenantId };
    if (filters?.role) where.role = filters.role as UserRole;
    if (filters?.isActive !== undefined) where.isActive = filters.isActive;
    return this.prisma.user.findMany({ where, select: userSelect, orderBy: { createdAt: 'desc' } });
  }

  async findOne(tenantId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: userSelect,
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return user;
  }

  async update(tenantId: string, userId: string, dto: UpdateUserDto, actorId: string) {
    try {
      return await this.mutate(
        tenantId,
        (tx) => this.updateInTransaction(tx, tenantId, userId, dto, {}, undefined, actorId),
        actorId,
      );
    } catch (error) {
      const prismaError = error as { code?: string; meta?: { target?: string[] } };
      if (prismaError.code === 'P2002' && prismaError.meta?.target?.includes('email')) {
        throw new ConflictException('Este email ya está registrado en esta clínica');
      }
      throw error;
    }
  }

  async updateSelf(tenantId: string, userId: string, dto: UpdateSelfProfileDto) {
    return this.mutate(
      tenantId,
      async (tx) => {
        const user = await tx.user.findFirst({
          where: { id: userId, tenantId },
          include: { professionalProfile: true },
        });
        if (!user) throw new NotFoundException('Usuario no encontrado');

        const profileInput = dto.professionalProfile;
        const currentProfile = user.professionalProfile;
        if (profileInput && !currentProfile) {
          throw new BadRequestException({
            statusCode: 400,
            code: 'PROFESSIONAL_PROFILE_NOT_FOUND',
            message: 'El usuario no tiene un perfil profesional editable.',
          });
        }

        const userData: Prisma.UserUpdateInput = {
          firstName: dto.firstName,
          lastName: dto.lastName,
          phone: dto.phone,
        };

        if (profileInput && currentProfile) {
          const professionalTitle =
            profileInput.professionalTitle ?? currentProfile.professionalTitle;
          const licenseNumber = profileInput.licenseNumber ?? currentProfile.licenseNumber;
          await tx.professionalProfile.update({
            where: { userId },
            data: {
              professionalTitle,
              licenseNumber,
              bio: profileInput.bio,
            },
          });
          userData.professionalTitle = professionalTitle;
          userData.licenseNumber = licenseNumber;
        }

        const updated = await tx.user.update({
          where: { id: userId },
          data: userData,
          select: selfUserSelect,
        });
        if (!updated.professionalProfile) {
          const { professionalProfile: _profile, ...withoutProfile } = updated;
          return withoutProfile;
        }
        return updated;
      },
      userId,
    );
  }

  private async updateInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    dto: UpdateUserDto,
    extra: Pick<Prisma.UserUpdateInput, 'password' | 'emailVerified' | 'activatedAt'> = {},
    accessFlow?: 'provider' | 'activation',
    actorId?: string,
  ) {
    const user = await tx.user.findFirst({
      where: { id: userId, tenantId },
      include: { professionalProfile: true },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (accessFlow === 'provider' && !user.managedByProvider)
      throw new BadRequestException('Este usuario no es gestionado por el proveedor');
    if (accessFlow === 'activation') {
      if (user.managedByProvider) {
        throw new ForbiddenException(
          'El acceso de este usuario debe ser concedido por el proveedor',
        );
      }
      if (user.isActive || !user.invitedAt || user.activatedAt) {
        throw new ConflictException({
          code: 'ACTIVATION_NOT_PENDING',
          message: 'Esta cuenta no tiene una invitación pendiente de activación.',
        });
      }
    }
    if (isMasterRole(user.role)) {
      // Support manages provider access outside the clinic's own team rules.
      const changesRole = !!dto.role && dto.role !== user.role;
      if (accessFlow !== 'provider' && (changesRole || dto.isActive === false)) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'MASTER_IMMUTABLE',
          message: 'El titular de la cuenta no puede cambiar de rol ni desactivarse.',
        });
      }
    } else if (dto.role && !ASSIGNABLE_TEAM_ROLES.includes(dto.role)) {
      throw roleNotAssignable();
    }
    if (dto.isActive === false && actorId === userId) {
      throw new ConflictException({
        code: 'CANNOT_DEACTIVATE_SELF',
        message: 'No puedes desactivar tu propia cuenta.',
      });
    }
    const normalizedEmail = dto.email?.trim().toLowerCase();
    if (normalizedEmail && normalizedEmail !== user.email.toLowerCase()) {
      const existing = await tx.user.findFirst({
        where: {
          tenantId,
          id: { not: userId },
          email: { equals: normalizedEmail, mode: 'insensitive' },
        },
      });
      if (existing) throw new ConflictException('Este email ya está registrado en esta clínica');
    }
    const current = user.professionalProfile;
    const input = this.resolveProfileInput(dto);
    const nextRole = dto.role ?? user.role;
    const remove =
      dto.professionalProfile === null ||
      (dto.role === UserRole.ASISTENTE &&
        current &&
        dto.professionalProfile === undefined &&
        !input);
    const profile = remove
      ? undefined
      : (input ??
        (current
          ? {
              specialtyId: current.specialtyId,
              professionalTitle: dto.professionalTitle ?? current.professionalTitle ?? undefined,
              licenseNumber: dto.licenseNumber ?? current.licenseNumber ?? undefined,
              bio: current.bio ?? undefined,
              isActive: current.isActive,
            }
          : undefined));
    if (profile) {
      // Metadata/specialty edits preserve activity unless explicitly changed.
      profile.isActive =
        dto.isActive === false
          ? false
          : (dto.professionalProfile?.isActive ??
            (dto.isActive === true ? true : (current?.isActive ?? true)));
      if (current) {
        profile.professionalTitle ??= current.professionalTitle ?? undefined;
        profile.licenseNumber ??= current.licenseNumber ?? undefined;
        profile.bio ??= current.bio ?? undefined;
      }
    }
    const activatesUser = !user.isActive && (dto.isActive ?? user.isActive);
    const activatesProfile = !current?.isActive && profile?.isActive;
    if (activatesProfile && !user.isActive && !activatesUser && !user.managedByProvider) {
      throw new ConflictException({
        code: 'INACTIVE_ACCOUNT_PROFILE',
        message: 'Activa la cuenta antes de activar su perfil profesional.',
      });
    }
    if (
      user.managedByProvider &&
      accessFlow !== 'provider' &&
      (accessFlow === 'activation' || (!user.isActive && (activatesUser || activatesProfile)))
    ) {
      throw new ForbiddenException('El acceso de este usuario debe ser concedido por el proveedor');
    }
    // Skip when nothing role/profile related changes, so profile-less professionals left by the
    // data migration can still be deactivated or edited.
    const touchesRoleOrProfile =
      (dto.role !== undefined && dto.role !== user.role) ||
      input !== undefined ||
      dto.professionalProfile !== undefined;
    if (touchesRoleOrProfile) this.profiles.validateRoleProfile(nextRole, profile);
    const hadClinicalCapacity = user.isActive && current?.isActive === true;
    const willHaveClinicalCapacity =
      (dto.isActive ?? user.isActive) &&
      profile?.isActive === true &&
      (isMasterRole(nextRole) || isProfessionalRole(nextRole));
    const losesClinicalCapacity = hadClinicalCapacity && !willHaveClinicalCapacity;
    if (losesClinicalCapacity) {
      await this.patientTeam.assertNoFutureAppointmentsForProfessional(tx, tenantId, userId);
    }
    if (profile) {
      if (!current || profile.specialtyId !== current.specialtyId) {
        await this.profiles.assertSpecialtyEnabled(tenantId, profile.specialtyId, tx);
        await this.profiles.assertSpecialtyChangeAllowed(tenantId, userId, profile.specialtyId, tx);
      }
      if (profile.isActive && !current?.isActive) await this.checkSeatAvailability(tenantId, tx);
    }
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        email: normalizedEmail,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        role: dto.role,
        isActive: dto.isActive,
        professionalTitle: remove ? null : (profile?.professionalTitle ?? dto.professionalTitle),
        licenseNumber: remove ? null : (profile?.licenseNumber ?? dto.licenseNumber),
        professionalProfile: profile
          ? { upsert: { create: profile, update: profile } }
          : remove && current
            ? { delete: true }
            : undefined,
        professionalSpecialties: profile
          ? { deleteMany: {}, create: { specialtyId: profile.specialtyId, isPrimary: true } }
          : remove
            ? { deleteMany: {} }
            : undefined,
        ...extra,
      },
      select: userSelect,
    });
    if (losesClinicalCapacity) {
      await this.patientTeam.deactivateAllForProfessional(tx, tenantId, userId);
    }
    await this.profiles.syncStoredSeatCount(tenantId, tx);
    const { password: _, ...safe } = updated as typeof updated & { password?: string };
    return safe;
  }

  async deactivate(tenantId: string, userId: string, actorId: string) {
    await this.update(tenantId, userId, { isActive: false }, actorId);
    return { message: 'Usuario desactivado exitosamente' };
  }

  async activate(tenantId: string, userId: string, password: string, actorId: string) {
    const hashedPassword = await this.authService.hashPassword(password);
    return this.mutate(
      tenantId,
      (tx) =>
        this.updateInTransaction(
          tx,
          tenantId,
          userId,
          { isActive: true },
          { password: hashedPassword, emailVerified: true, activatedAt: new Date() },
          'activation',
        ),
      actorId,
    );
  }

  /**
   * Change user's own password
   * Verifies current password before updating
   */
  async changePassword(
    tenantId: string,
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    // Verify current password
    const bcrypt = await import('bcrypt');
    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('La contraseña actual es incorrecta');
    }

    // Hash and update new password
    const hashedNewPassword = await this.authService.hashPassword(newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword, mustChangePassword: false },
    });

    return { message: 'Contraseña cambiada exitosamente' };
  }

  async uploadAvatar(
    tenantId: string,
    userId: string,
    currentUserId: string,
    currentUserRole: string,
    file: any,
  ) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    // Only the same user or a MASTER can change the avatar.
    if (!isMasterRole(currentUserRole) && currentUserId !== userId) {
      throw new ForbiddenException('Solo puedes actualizar tu propio avatar');
    }

    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Solo se permiten archivos de imagen');
    }

    const avatarUrl = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;

    return this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
      select: {
        ...professionalFields,
        id: true,
        tenantId: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        emailVerified: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async grantPsychologistAccess(tenantId: string, userId: string) {
    await this.mutate(tenantId, (tx) =>
      this.updateInTransaction(
        tx,
        tenantId,
        userId,
        { isActive: true },
        { activatedAt: new Date() },
        'provider',
      ),
    );
    return { message: 'Acceso concedido exitosamente' };
  }

  async revokePsychologistAccess(tenantId: string, userId: string) {
    await this.mutate(tenantId, (tx) =>
      this.updateInTransaction(tx, tenantId, userId, { isActive: false }, {}, 'provider'),
    );
    return { message: 'Acceso del usuario revocado exitosamente' };
  }

  async listPendingPsychologists() {
    return this.prisma.user.findMany({
      where: {
        role: UserRole.PROFESIONAL,
        managedByProvider: true,
        isActive: false,
      },
      select: { ...userSelect, tenant: { select: { name: true, tenantType: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Pending invitations are activated by the account holder; the message only announces the account. */
  private async sendInvitationEmail(tenantId: string, user: { email: string; firstName: string }) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    await this.mail.sendInvitation(user.email, {
      firstName: user.firstName,
      clinicName: tenant?.name ?? 'tu consultorio',
    });
  }
}
