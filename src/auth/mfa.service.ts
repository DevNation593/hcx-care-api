import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { toCanonicalRole } from '../common/roles/role-compatibility';
import { PrismaService } from '../prisma/prisma.service';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotp,
  otpauthUrl,
} from './totp';

/** How long the second step of a sign-in may take after the password was accepted. */
const CHALLENGE_TTL = '5m';
const CHALLENGE_PURPOSE = 'mfa-challenge';

type PolicyUser = Pick<User, 'role' | 'mfaEnabledAt'> & {
  tenant: { isPlatform: boolean; settings?: { requireMfa: boolean } | null };
};

/**
 * Whether the account must sign in with a second factor (SEG-01): the account holder and the
 * professionals of a clinic that requires it, and the platform administrators when
 * PLATFORM_ADMIN_MFA_REQUIRED=true. Assistants and cashiers are not required (yet) but may enrol.
 */
export function mfaRequiredFor(user: PolicyUser, platformAdminsRequired: boolean): boolean {
  if (user.tenant.isPlatform) return platformAdminsRequired;
  const role = toCanonicalRole(user.role);
  return user.tenant.settings?.requireMfa === true && (role === 'MASTER' || role === 'PROFESIONAL');
}

const invalidCode = () =>
  new ForbiddenException({
    statusCode: 403,
    code: 'MFA_CODE_INVALID',
    message: 'El código no es correcto o ya se usó. Escribe el código actual de tu aplicación.',
  });

const passwordInvalid = () =>
  new ForbiddenException({
    statusCode: 403,
    code: 'MFA_PASSWORD_INVALID',
    message: 'La contraseña no es correcta.',
  });

/**
 * Two-factor sign-in with authenticator apps (TOTP) and single-use recovery codes. The secret is
 * stored encrypted, the recovery codes as hashes; a code is accepted once (the last step used is
 * kept), and every change is written to the audit log of the clinic.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  get platformAdminsRequired(): boolean {
    return this.config.get<string>('PLATFORM_ADMIN_MFA_REQUIRED') === 'true';
  }

  isRequired(user: PolicyUser): boolean {
    return mfaRequiredFor(user, this.platformAdminsRequired);
  }

  /** Whether the account has to enrol before it can use anything but its session routes. */
  enrollmentRequired(user: PolicyUser): boolean {
    return !user.mfaEnabledAt && this.isRequired(user);
  }

  async status(userId: string) {
    const user = await this.findUser(userId);
    return {
      enabled: Boolean(user.mfaEnabledAt),
      enabledAt: user.mfaEnabledAt,
      required: this.isRequired(user),
      recoveryCodesLeft: user.mfaRecoveryCodes.length,
    };
  }

  /**
   * Starts an enrolment: a new secret, kept apart until a code from it is confirmed. The password
   * is asked again so an open session alone cannot add a second factor of someone else's.
   */
  async setup(userId: string, password: string) {
    const user = await this.findUser(userId);
    await this.assertPassword(user, password);
    if (user.mfaEnabledAt) {
      throw new ConflictException({
        statusCode: 409,
        code: 'MFA_ALREADY_ENABLED',
        message:
          'La verificación en dos pasos ya está activa. Desactívala antes de configurarla otra vez.',
      });
    }
    const secret = generateTotpSecret();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { mfaPendingSecret: this.crypto.encrypt(user.tenantId, secret) },
    });
    const url = otpauthUrl(this.config.get<string>('MFA_ISSUER') || 'HCX Care', user.email, secret);
    return { secret, otpauthUrl: url, qrCodeDataUrl: await QRCode.toDataURL(url, { margin: 1 }) };
  }

  /** Confirms the enrolment with a code of the new secret and returns the recovery codes, once. */
  async enable(userId: string, code: string) {
    const user = await this.findUser(userId);
    if (!user.mfaPendingSecret) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'MFA_SETUP_REQUIRED',
        message: 'Primero genera el código QR y escanéalo con tu aplicación.',
      });
    }
    const secret = this.crypto.decrypt(user.tenantId, user.mfaPendingSecret);
    const step = matchTotp(secret, code);
    if (step === null) throw invalidCode();

    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaSecret: user.mfaPendingSecret,
          mfaPendingSecret: null,
          mfaEnabledAt: new Date(),
          mfaLastStep: step,
          mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode),
        },
      });
      await this.auditUser(tx, user, user.id, 'Verificación en dos pasos activada');
    });
    return { recoveryCodes };
  }

  /** Turns the second factor off: the password and a current code. Refused while required. */
  async disable(userId: string, password: string, code: string) {
    const user = await this.findUser(userId);
    await this.assertPassword(user, password);
    if (this.isRequired(user)) {
      throw new ConflictException({
        statusCode: 409,
        code: 'MFA_REQUIRED_BY_POLICY',
        message: 'Tu consultorio exige la verificación en dos pasos: no se puede desactivar.',
      });
    }
    if (!(await this.verify(user, { code }))) throw invalidCode();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: this.cleared() });
      await this.auditUser(tx, user, user.id, 'Verificación en dos pasos desactivada');
    });
    return { enabled: false };
  }

  /** New recovery codes, after a current code; the previous ones stop working. */
  async regenerateRecoveryCodes(userId: string, code: string) {
    const user = await this.findUser(userId);
    if (!user.mfaEnabledAt || !(await this.verify(user, { code }))) throw invalidCode();
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { mfaRecoveryCodes: recoveryCodes.map(hashRecoveryCode) },
      });
      await this.auditUser(tx, user, user.id, 'Códigos de recuperación regenerados');
    });
    return { recoveryCodes };
  }

  /**
   * The account holder removes the second factor of someone of the clinic who lost their phone.
   * Their sessions end; if the clinic requires it they enrol again at their next sign-in.
   */
  async resetForUser(tenantId: string, actorId: string, userId: string) {
    if (actorId === userId) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'MFA_RESET_SELF',
        message: 'Para cambiar tu propia verificación en dos pasos usa tu perfil.',
      });
    }
    const user = await this.prisma.user.findFirst({ where: { id: userId, tenantId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: this.cleared() });
      await tx.refreshToken.updateMany({
        where: { userId: user.id, isRevoked: false },
        data: { isRevoked: true },
      });
      await this.auditUser(
        tx,
        user,
        actorId,
        'Verificación en dos pasos restablecida por el titular',
      );
    });
    return { userId, enabled: false };
  }

  /** The short-lived proof that the password of `userId` was accepted, for the second step. */
  challengeToken(userId: string): string {
    return this.jwt.sign(
      { sub: userId, purpose: CHALLENGE_PURPOSE },
      { secret: this.challengeSecret(), expiresIn: CHALLENGE_TTL },
    );
  }

  /** The user a challenge token was issued for; 401 when it expired or was tampered with. */
  userIdOfChallenge(token: string): string {
    try {
      const payload = this.jwt.verify(token, { secret: this.challengeSecret() });
      if (payload?.purpose !== CHALLENGE_PURPOSE || typeof payload.sub !== 'string')
        throw new Error();
      return payload.sub;
    } catch {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'MFA_CHALLENGE_EXPIRED',
        message: 'El inicio de sesión expiró. Escribe otra vez tu correo y contraseña.',
      });
    }
  }

  /**
   * Checks a TOTP code (accepted once: its step must be later than the last one used) or a
   * recovery code (removed when used). Both updates are conditional, so two requests with the
   * same code cannot both succeed.
   */
  async verify(
    user: Pick<User, 'id' | 'tenantId' | 'mfaSecret'>,
    input: { code?: string; recoveryCode?: string },
  ): Promise<boolean> {
    if (!user.mfaSecret) return false;
    if (input.code) {
      const step = matchTotp(this.crypto.decrypt(user.tenantId, user.mfaSecret), input.code);
      if (step === null) return false;
      const claimed = await this.prisma.user.updateMany({
        where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
        data: { mfaLastStep: step },
      });
      return claimed.count === 1;
    }
    if (input.recoveryCode) {
      const hash = hashRecoveryCode(input.recoveryCode);
      const current = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { mfaRecoveryCodes: true },
      });
      if (!current?.mfaRecoveryCodes.includes(hash)) return false;
      const claimed = await this.prisma.user.updateMany({
        where: { id: user.id, mfaRecoveryCodes: { has: hash } },
        data: { mfaRecoveryCodes: current.mfaRecoveryCodes.filter((stored) => stored !== hash) },
      });
      return claimed.count === 1;
    }
    return false;
  }

  private cleared(): Prisma.UserUpdateInput {
    return {
      mfaSecret: null,
      mfaPendingSecret: null,
      mfaEnabledAt: null,
      mfaLastStep: null,
      mfaRecoveryCodes: [],
    };
  }

  private challengeSecret(): string {
    // Its own secret: an access or refresh token is never accepted as a challenge, nor the reverse.
    return `${this.config.get<string>('JWT_ACCESS_SECRET')}:mfa-challenge`;
  }

  private async assertPassword(user: User, password: string) {
    if (!password || !(await bcrypt.compare(password, user.password))) throw passwordInvalid();
  }

  private async findUser(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, isActive: true },
      include: {
        tenant: { select: { isPlatform: true, settings: { select: { requireMfa: true } } } },
      },
    });
    if (!user) throw new UnauthorizedException('Usuario no encontrado');
    return user;
  }

  private async auditUser(
    tx: Prisma.TransactionClient,
    user: Pick<User, 'id' | 'tenantId'>,
    actorId: string,
    reason: string,
  ) {
    await tx.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: actorId,
        action: 'UPDATE',
        entity: 'USER',
        entityId: user.id,
        reason,
      },
    });
  }
}
