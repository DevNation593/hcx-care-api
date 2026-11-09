import { AuthResponseDto } from '../src/auth/dto/auth.dto';
import { MfaService } from '../src/auth/mfa.service';
import { MailService } from '../src/mail/mail.service';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

describe('Auth professional profile payload', () => {
  let service: AuthService;
  let user: any;
  let db: any;
  let jwt: any;

  beforeEach(async () => {
    user = {
      id: 'clinical-admin',
      tenantId: 'clinic-1',
      email: 'admin@test.invalid',
      firstName: 'Clinical',
      lastName: 'Admin',
      role: 'MASTER',
      isActive: true,
      password: await bcrypt.hash('Password123!', 4),
      updatedAt: new Date(),
      lastActivityAt: new Date(),
      tenant: { isActive: true },
      professionalProfile: { specialty: { id: 'specialty-1', code: 'CLINICAL', name: 'Clinical' } },
    };
    db = {
      user: {
        findMany: jest.fn().mockResolvedValue([user]),
        update: jest.fn().mockResolvedValue(user),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({
          id: 'refresh-1',
          familyId: 'family-1',
          isRevoked: false,
          expiresAt: new Date(Date.now() + 60000),
          user,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      withRlsContext: jest.fn(async (_context, callback) => callback()),
    };
    jwt = {
      sign: jest.fn((payload) => JSON.stringify(payload)),
      verify: jest.fn((token) => JSON.parse(token)),
    };
    service = new AuthService(
      db as PrismaService,
      jwt as JwtService,
      { get: jest.fn().mockReturnValue('secret') } as unknown as ConfigService,
      {} as MailService,
      { enrollmentRequired: () => false } as unknown as MfaService,
    );
  });

  it('includes specialty in login while retaining the persisted JWT role', async () => {
    const result = (await service.login({
      email: user.email,
      password: 'Password123!',
    })) as AuthResponseDto;
    expect(result.user).toMatchObject({
      id: user.id,
      tenantId: user.tenantId,
      role: 'MASTER',
      professionalProfile: { specialty: { id: 'specialty-1', name: 'Clinical' } },
    });
    expect(JSON.parse(result.accessToken).role).toBe('MASTER');
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          tenant: { include: { settings: { select: { requireMfa: true } } } },
          professionalProfile: { include: { specialty: true } },
        },
      }),
    );
  });

  it('includes specialty in refresh while retaining the persisted JWT role', async () => {
    const previousToken = JSON.stringify({
      sub: user.id,
      email: user.email,
      tenantId: user.tenantId,
      role: 'MASTER',
    });
    const result = await service.refreshTokens(previousToken);
    expect(result.user).toMatchObject({
      id: user.id,
      tenantId: user.tenantId,
      role: 'MASTER',
      professionalProfile: { specialty: { id: 'specialty-1', name: 'Clinical' } },
    });
    expect(JSON.parse(result.accessToken).role).toBe('MASTER');
    expect(result.refreshToken).not.toBe(previousToken);
    expect(db.refreshToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          user: {
            include: {
              tenant: { include: { settings: { select: { requireMfa: true } } } },
              professionalProfile: { include: { specialty: true } },
            },
          },
        },
      }),
    );
  });
});
