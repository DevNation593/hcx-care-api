import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { MfaEnrollmentGuard } from '../common/guards/mfa-enrollment.guard';
import { PrismaService } from '../prisma/prisma.service';
import { MfaService, mfaRequiredFor } from './mfa.service';
import { hashRecoveryCode, totpCode, totpStep } from './totp';

type Row = Record<string, any>;

describe('MfaService', () => {
  const crypto = new ClinicalCipher([
    { id: 'k1', key: Buffer.alloc(32, 3) },
  ]) as unknown as ClinicalCryptoService;
  const config = (values: Record<string, string> = {}) =>
    ({
      get: (key: string) => ({ JWT_ACCESS_SECRET: 'access-secret', ...values })[key],
    }) as unknown as ConfigService;
  let user: Row;
  let audits: Row[];
  let service: MfaService;

  const prisma = {
    user: {
      findFirst: jest.fn(async () => ({ ...user })),
      findUnique: jest.fn(async () => ({ ...user })),
      update: jest.fn(async ({ data }: Row) => Object.assign(user, data)),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        const step = where.OR?.[1]?.mfaLastStep?.lt;
        if (step !== undefined && user.mfaLastStep !== null && user.mfaLastStep >= step) {
          return { count: 0 };
        }
        const has = where.mfaRecoveryCodes?.has;
        if (has && !user.mfaRecoveryCodes.includes(has)) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      }),
    },
    refreshToken: { updateMany: jest.fn() },
    auditLog: { create: jest.fn(async ({ data }: Row) => audits.push(data)) },
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const now = () => totpCode(user.secretForTest, totpStep(new Date()));

  beforeEach(async () => {
    jest.clearAllMocks();
    audits = [];
    user = {
      id: 'user-1',
      tenantId: 'tenant-1',
      email: 'ana@example.com',
      role: 'PROFESIONAL',
      password: await bcrypt.hash('Password123!', 4),
      mfaSecret: null,
      mfaPendingSecret: null,
      mfaEnabledAt: null,
      mfaLastStep: null,
      mfaRecoveryCodes: [],
      tenant: { isPlatform: false, settings: { requireMfa: false } },
    };
    service = new MfaService(
      prisma as unknown as PrismaService,
      crypto,
      new JwtService({}),
      config(),
    );
  });

  const enrol = async () => {
    const { secret } = await service.setup('user-1', 'Password123!');
    user.secretForTest = secret;
    return service.enable('user-1', now());
  };

  it('enrols with a QR, stores the secret encrypted and gives the recovery codes once', async () => {
    const setup = await service.setup('user-1', 'Password123!');
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    expect(setup.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(user.mfaPendingSecret).not.toContain(setup.secret);
    expect(user.mfaEnabledAt).toBeNull();

    user.secretForTest = setup.secret;
    const { recoveryCodes } = await service.enable('user-1', now());

    expect(recoveryCodes).toHaveLength(10);
    expect(user.mfaEnabledAt).toBeInstanceOf(Date);
    expect(user.mfaPendingSecret).toBeNull();
    expect(user.mfaRecoveryCodes).toEqual(recoveryCodes.map(hashRecoveryCode));
    expect(audits).toEqual([
      expect.objectContaining({ entity: 'USER', reason: expect.stringMatching(/activada/) }),
    ]);
  });

  it('asks the password to start, and a correct code to finish', async () => {
    await expect(service.setup('user-1', 'wrong')).rejects.toMatchObject({
      response: { code: 'MFA_PASSWORD_INVALID' },
    });
    await service.setup('user-1', 'Password123!');
    await expect(service.enable('user-1', '000000')).rejects.toMatchObject({
      response: { code: 'MFA_CODE_INVALID' },
    });
    expect(user.mfaEnabledAt).toBeNull();
  });

  it('accepts a code once: the same code again is refused', async () => {
    await enrol();
    // The enrolment used the current step: the same code no longer signs in.
    expect(await service.verify(user as never, { code: now() })).toBe(false);
  });

  it('accepts each recovery code once', async () => {
    const { recoveryCodes } = await enrol();

    expect(
      await service.verify(user as never, { recoveryCode: recoveryCodes[3].toUpperCase() }),
    ).toBe(true);
    expect(user.mfaRecoveryCodes).toHaveLength(9);
    expect(await service.verify(user as never, { recoveryCode: recoveryCodes[3] })).toBe(false);
  });

  it('cannot be turned off while the clinic requires it', async () => {
    await enrol();
    user.tenant.settings.requireMfa = true;
    user.mfaLastStep = null;

    await expect(service.disable('user-1', 'Password123!', now())).rejects.toMatchObject({
      response: { code: 'MFA_REQUIRED_BY_POLICY' },
    });
    expect(user.mfaEnabledAt).toBeInstanceOf(Date);
  });

  it('lets the account holder reset someone else, ending their sessions', async () => {
    await enrol();

    await service.resetForUser('tenant-1', 'master', 'user-1');

    expect(user.mfaEnabledAt).toBeNull();
    expect(user.mfaSecret).toBeNull();
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isRevoked: false },
      data: { isRevoked: true },
    });
    await expect(service.resetForUser('tenant-1', 'user-1', 'user-1')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('issues a challenge only it accepts, for its own user', () => {
    const token = service.challengeToken('user-1');

    expect(service.userIdOfChallenge(token)).toBe('user-1');
    // An access token, signed with the access secret, is not a challenge.
    const access = new JwtService({}).sign({ sub: 'user-1' }, { secret: 'access-secret' });
    expect(() => service.userIdOfChallenge(access)).toThrow();
  });
});

describe('who must sign in with a second factor', () => {
  const user = (role: string, requireMfa: boolean, isPlatform = false) => ({
    role,
    mfaEnabledAt: null,
    tenant: { isPlatform, settings: { requireMfa } },
  });

  it('is the account holder and the professionals of a clinic that requires it', () => {
    expect(mfaRequiredFor(user('MASTER', true) as never, false)).toBe(true);
    expect(mfaRequiredFor(user('PROFESIONAL', true) as never, false)).toBe(true);
    expect(mfaRequiredFor(user('ASISTENTE', true) as never, false)).toBe(false);
    expect(mfaRequiredFor(user('PROFESIONAL', false) as never, false)).toBe(false);
  });

  it('is the platform administrators when the platform says so', () => {
    expect(mfaRequiredFor(user('ADMIN', false, true) as never, true)).toBe(true);
    expect(mfaRequiredFor(user('ADMIN', false, true) as never, false)).toBe(false);
  });
});

describe('MfaEnrollmentGuard', () => {
  const guard = new MfaEnrollmentGuard(new Reflector());
  const context = (user: Row, handler: () => void = () => undefined) =>
    ({
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  it('stops an account that must enrol, and lets the others through', () => {
    expect(() => guard.canActivate(context({ mfaEnrollmentRequired: true }))).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'MFA_ENROLLMENT_REQUIRED' }),
      }),
    );
    expect(guard.canActivate(context({ mfaEnrollmentRequired: false }))).toBe(true);
  });
});
