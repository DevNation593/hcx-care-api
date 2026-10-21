import { AestheticsService } from './aesthetics.service';

describe('AestheticsService', () => {
  const futureStart = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const tx = {
    aestheticClient: { findFirst: jest.fn() },
    aestheticService: { findFirst: jest.fn() },
    user: { findFirst: jest.fn() },
    aestheticBooking: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    aestheticSession: { findFirst: jest.fn(), update: jest.fn() },
    aestheticConsent: { findFirst: jest.fn(), create: jest.fn() },
  };
  const prisma = { ...tx, $transaction: jest.fn(), applyRlsContext: jest.fn() };
  const crypto = {
    enabled: true,
    encrypt: jest.fn((_: string, value: string) => `encrypted:${value}`),
    decrypt: jest.fn((_: string, value: string) => value.replace(/^encrypted:/, '')),
  };
  const service = new AestheticsService(prisma as never, crypto as never);

  beforeEach(() => {
    jest.resetAllMocks();
    crypto.encrypt.mockImplementation((_: string, value: string) => `encrypted:${value}`);
    crypto.decrypt.mockImplementation((_: string, value: string) =>
      value.replace(/^encrypted:/, ''),
    );
    prisma.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    tx.aestheticClient.findFirst.mockResolvedValue({ id: 'client-1' });
    tx.aestheticService.findFirst.mockResolvedValue({
      id: 'service-1',
      durationMinutes: 60,
      isActive: true,
    });
    tx.user.findFirst.mockResolvedValue({ id: 'staff-1' });
    tx.aestheticBooking.findFirst.mockResolvedValue(null);
    tx.aestheticBooking.create.mockImplementation(async ({ data }) => ({
      id: 'booking-1',
      ...data,
    }));
    tx.aestheticBooking.updateMany.mockResolvedValue({ count: 1 });
  });

  it('rejects a client belonging to another studio before booking', async () => {
    tx.aestheticClient.findFirst.mockResolvedValue(null);
    await expect(
      service.createBooking(
        'studio-1',
        {
          clientId: 'client-foreign',
          serviceId: 'service-1',
          staffId: 'staff-1',
          startAt: futureStart.toISOString(),
        },
        'actor-1',
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(tx.aestheticClient.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-foreign', tenantId: 'studio-1', isActive: true },
    });
    expect(tx.aestheticBooking.create).not.toHaveBeenCalled();
  });

  it('rejects an overlapping booking for the same staff member', async () => {
    tx.aestheticBooking.findFirst.mockResolvedValue({ id: 'other-booking' });
    await expect(
      service.createBooking(
        'studio-1',
        {
          clientId: 'client-1',
          serviceId: 'service-1',
          staffId: 'staff-1',
          startAt: futureStart.toISOString(),
        },
        'actor-1',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.aestheticBooking.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 'studio-1',
        staffId: 'staff-1',
        status: 'SCHEDULED',
        startAt: { lt: new Date(futureStart.getTime() + 60 * 60 * 1000) },
        endAt: { gt: futureStart },
      }),
    });
    expect(tx.aestheticBooking.create).not.toHaveBeenCalled();
  });

  it('snapshots the service consent and signer instead of linking mutable text', async () => {
    tx.aestheticSession.findFirst.mockResolvedValue({
      id: 'session-1',
      tenantId: 'studio-1',
      service: { consentText: 'Autorizo el procedimiento' },
    });
    tx.aestheticConsent.findFirst.mockResolvedValue(null);
    tx.aestheticConsent.create.mockImplementation(async ({ data }) => ({
      id: 'consent-1',
      ...data,
    }));
    const result = await service.recordConsent(
      'studio-1',
      'session-1',
      { signerName: 'Ana Paz', expectedConsentText: 'Autorizo el procedimiento' },
      'staff-1',
    );
    expect(tx.aestheticConsent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'studio-1',
        sessionId: 'session-1',
        bodySnapshot: 'encrypted:Autorizo el procedimiento',
        signerName: 'encrypted:Ana Paz',
        recordedById: 'staff-1',
      }),
    });
    expect(result.bodySnapshot).toBe('Autorizo el procedimiento');
    expect(result.signerName).toBe('Ana Paz');
  });

  it('rejects consent when the template changed after it was shown', async () => {
    tx.aestheticSession.findFirst.mockResolvedValue({
      id: 'session-1',
      service: { consentText: 'Texto nuevo' },
    });
    await expect(
      service.recordConsent(
        'studio-1',
        'session-1',
        { signerName: 'Ana Paz', expectedConsentText: 'Texto anterior' },
        'staff-1',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.aestheticConsent.create).not.toHaveBeenCalled();
  });

  it('does not record consent after a session is complete', async () => {
    tx.aestheticSession.findFirst.mockResolvedValue({
      id: 'session-1',
      completedAt: new Date(),
      service: { consentText: 'Texto agregado después' },
    });
    await expect(
      service.recordConsent(
        'studio-1',
        'session-1',
        { signerName: 'Ana Paz', expectedConsentText: 'Texto agregado después' },
        'staff-1',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.aestheticConsent.create).not.toHaveBeenCalled();
  });

  it('checks overlap before reactivating a cancelled booking', async () => {
    tx.aestheticBooking.findFirst
      .mockResolvedValueOnce({
        id: 'booking-1',
        status: 'CANCELLED',
        staffId: 'staff-1',
        startAt: futureStart,
        service: { durationMinutes: 60 },
      })
      .mockResolvedValueOnce({ id: 'another-booking' });
    await expect(
      service.updateBooking('studio-1', 'booking-1', { status: 'SCHEDULED' }, 'actor-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.aestheticBooking.update).not.toHaveBeenCalled();
  });

  it('does not allow a booking to be marked complete without completing its session', async () => {
    tx.aestheticBooking.findFirst.mockResolvedValue({
      id: 'booking-1',
      status: 'SCHEDULED',
      staffId: 'staff-1',
      startAt: futureStart,
      service: { durationMinutes: 60 },
    });
    await expect(
      service.updateBooking('studio-1', 'booking-1', { status: 'COMPLETED' }, 'actor-1'),
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.aestheticBooking.update).not.toHaveBeenCalled();
  });

  it('marks the linked booking complete in the same transaction as its session', async () => {
    tx.aestheticSession.findFirst.mockResolvedValue({
      id: 'session-1',
      bookingId: 'booking-1',
      completedAt: null,
      service: { consentText: null },
      consent: null,
    });
    tx.aestheticSession.update.mockResolvedValue({
      id: 'session-1',
      completedAt: new Date(),
      notes: null,
      consent: null,
    });
    await service.completeSession('studio-1', 'session-1', {}, 'actor-1');
    expect(tx.aestheticBooking.updateMany).toHaveBeenCalledWith({
      where: { id: 'booking-1', tenantId: 'studio-1', status: 'SCHEDULED' },
      data: { status: 'COMPLETED' },
    });
  });
});
