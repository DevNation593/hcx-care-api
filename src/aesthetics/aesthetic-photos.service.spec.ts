import { AestheticPhotosService } from './aesthetic-photos.service';
import { ClinicalCipher } from '../clinical-access/clinical-cipher';

describe('AestheticPhotosService', () => {
  const tx = {
    tenantSubscription: { findUnique: jest.fn(), updateMany: jest.fn() },
    aestheticPhoto: { create: jest.fn() },
  };
  const prisma = {
    aestheticSession: { findFirst: jest.fn() },
    aestheticPhoto: { findFirst: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
  };
  const crypto = new ClinicalCipher([{ id: 'test', key: Buffer.alloc(32, 7) }]);
  const storage = { put: jest.fn(), get: jest.fn(), remove: jest.fn() };
  const service = new AestheticPhotosService(prisma as never, crypto as never, storage as never);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.aestheticSession.findFirst.mockResolvedValue({ id: 'session-1' });
    prisma.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    tx.tenantSubscription.findUnique.mockResolvedValue({ storageGB: 1 });
    tx.tenantSubscription.updateMany.mockResolvedValue({ count: 1 });
    tx.aestheticPhoto.create.mockImplementation(async ({ data }) => ({
      id: 'photo-1',
      createdAt: new Date(),
      ...data,
    }));
  });

  it('rejects a session from another studio before uploading bytes', async () => {
    prisma.aestheticSession.findFirst.mockResolvedValue(null);
    await expect(
      service.upload(
        'studio-1',
        'foreign-session',
        'BEFORE',
        {
          mimetype: 'image/jpeg',
          size: jpeg.length,
          buffer: jpeg,
          originalname: 'before.jpg',
        },
        { userId: 'user-1', role: 'MASTER' },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('stores encrypted bytes and never returns the storage key', async () => {
    const result = await service.upload(
      'studio-1',
      'session-1',
      'AFTER',
      {
        mimetype: 'image/jpeg',
        size: jpeg.length,
        buffer: jpeg,
        originalname: 'after.jpg',
      },
      { userId: 'user-1', role: 'MASTER' },
    );
    const [storageKey, stored] = storage.put.mock.calls[0] as [string, Buffer];
    expect(storageKey).toMatch(/^studio-1\/aesthetics\/session-1\//);
    expect(stored).not.toEqual(jpeg);
    expect(stored.subarray(0, 4).toString('ascii')).toBe('ENC1');
    expect(crypto.decryptBuffer('studio-1', stored)).toEqual(jpeg);
    expect(tx.tenantSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'studio-1' }),
        data: { storageUsedBytes: { increment: BigInt(jpeg.length) } },
      }),
    );
    expect(result).not.toHaveProperty('storageKey');
  });

  it('refuses to store a photo if encryption is not configured', async () => {
    const noKey = new AestheticPhotosService(
      prisma as never,
      new ClinicalCipher([]) as never,
      storage as never,
    );
    await expect(
      noKey.upload(
        'studio-1',
        'session-1',
        'BEFORE',
        { mimetype: 'image/jpeg', size: jpeg.length, buffer: jpeg, originalname: 'before.jpg' },
        { userId: 'user-1', role: 'MASTER' },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(storage.put).not.toHaveBeenCalled();
  });
});
