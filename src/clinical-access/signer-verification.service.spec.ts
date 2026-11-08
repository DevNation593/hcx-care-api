import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { SignerVerificationService } from './signer-verification.service';

describe('SignerVerificationService', () => {
  const prisma = { user: { findUnique: jest.fn() } };
  const service = new SignerVerificationService(prisma as unknown as PrismaService);
  let hash: string;

  beforeAll(async () => {
    hash = await bcrypt.hash('Clave-Segura-1', 4);
  });
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.user.findUnique.mockResolvedValue({ password: hash, isActive: true });
  });

  it('lets the professional sign with their own password', async () => {
    await expect(service.verify('pro-1', 'Clave-Segura-1')).resolves.toBeUndefined();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      select: { password: true, isActive: true },
    });
  });

  it.each([
    ['without a password', undefined],
    ['with an empty one', ''],
    ['with a wrong one', 'otra-clave'],
  ])('refuses to sign %s, with a 403 that keeps the session', async (_case, password) => {
    await expect(service.verify('pro-1', password)).rejects.toMatchObject({
      status: 403,
      response: { code: 'SIGNATURE_PASSWORD_INVALID' },
    });
  });

  it('refuses an account that was deactivated', async () => {
    prisma.user.findUnique.mockResolvedValue({ password: hash, isActive: false });

    await expect(service.verify('pro-1', 'Clave-Segura-1')).rejects.toMatchObject({ status: 403 });
  });
});
