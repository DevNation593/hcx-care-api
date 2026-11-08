import { NotFoundException } from '@nestjs/common';
import { DemoRequestsService } from './demo-requests.service';
import { CreateDemoRequestDto } from './dto/demo-request.dto';

const NOW = new Date('2026-11-07T15:00:00Z');

const dto: CreateDemoRequestDto = {
  name: 'Ana Vega',
  clinic: 'Centro Vida',
  email: 'ana@example.com',
  phone: '0991234567',
  teamSize: '2-5',
  message: '',
  acceptPrivacy: true,
};

function setup(env: Record<string, string> = {}) {
  const prisma = {
    demoRequest: {
      create: jest.fn(async ({ data }) => ({ id: 'dr1', status: 'NEW', handledAt: null, ...data })),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(async ({ data }) => ({ id: 'dr1', ...data })),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ email: 'admin@platform.test' }]) },
  };
  const mail = { webUrl: 'https://app.test', send: jest.fn().mockResolvedValue(true) };
  const config = { get: jest.fn((key: string) => env[key]) };
  const service = new DemoRequestsService(prisma as never, mail as never, config as never);
  return { service, prisma, mail };
}

describe('DemoRequestsService', () => {
  it('saves the request with the privacy acceptance time and notifies the platform admins', async () => {
    const { service, prisma, mail } = setup();

    await expect(service.create(dto, NOW)).resolves.toEqual({ received: true });

    expect(prisma.demoRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        clinic: 'Centro Vida',
        message: null,
        privacyAcceptedAt: NOW,
      }),
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: 'ADMIN', isActive: true, tenant: { isPlatform: true } },
      }),
    );
    expect(mail.send).toHaveBeenCalledTimes(1);
    const [to, content] = mail.send.mock.calls[0];
    expect(to).toBe('admin@platform.test');
    expect(content.subject).toContain('Centro Vida');
    expect(content.text).toContain('ana@example.com');
    expect(content.text).toContain('https://app.test/platform/demo-requests');
    expect(content.sensitive).toBe(true);
  });

  it('sends one notice per configured address instead of the platform admins', async () => {
    const { service, prisma, mail } = setup({
      DEMO_REQUEST_NOTIFY_EMAIL: 'ventas@a.test, demo@a.test',
    });

    await service.create(dto, NOW);

    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(mail.send.mock.calls.map(([to]) => to)).toEqual(['ventas@a.test', 'demo@a.test']);
  });

  it('keeps the request when the notice cannot be delivered', async () => {
    const { service, prisma, mail } = setup();
    mail.send.mockResolvedValue(false);

    await expect(service.create(dto, NOW)).resolves.toEqual({ received: true });
    expect(prisma.demoRequest.create).toHaveBeenCalled();
  });

  it('escapes the visitor text in the HTML notice', async () => {
    const { service, mail } = setup();

    await service.create({ ...dto, clinic: '<script>x</script>' }, NOW);

    const [, content] = mail.send.mock.calls[0];
    expect(content.html).not.toContain('<script>');
    expect(content.html).toContain('&lt;script&gt;');
  });

  it('drops a request that filled the honeypot, answering the same', async () => {
    const { service, prisma, mail } = setup();

    await expect(service.create({ ...dto, website: 'http://spam.test' }, NOW)).resolves.toEqual({
      received: true,
    });
    expect(prisma.demoRequest.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('lists by status, newest first', async () => {
    const { service, prisma } = setup();

    await service.list('NEW');

    expect(prisma.demoRequest.findMany).toHaveBeenCalledWith({
      where: { status: 'NEW' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  describe('updateStatus', () => {
    it('stamps the first time a request is handled and keeps it afterwards', async () => {
      const { service, prisma } = setup();
      prisma.demoRequest.findUnique.mockResolvedValueOnce({ id: 'dr1', handledAt: null });
      await service.updateStatus('dr1', 'CONTACTED', NOW);
      expect(prisma.demoRequest.update).toHaveBeenLastCalledWith({
        where: { id: 'dr1' },
        data: { status: 'CONTACTED', handledAt: NOW },
      });

      const earlier = new Date('2026-11-01T00:00:00Z');
      prisma.demoRequest.findUnique.mockResolvedValueOnce({ id: 'dr1', handledAt: earlier });
      await service.updateStatus('dr1', 'CLOSED', NOW);
      expect(prisma.demoRequest.update).toHaveBeenLastCalledWith({
        where: { id: 'dr1' },
        data: { status: 'CLOSED', handledAt: earlier },
      });
    });

    it('clears the handled time when the request goes back to new', async () => {
      const { service, prisma } = setup();
      prisma.demoRequest.findUnique.mockResolvedValueOnce({ id: 'dr1', handledAt: NOW });
      await service.updateStatus('dr1', 'NEW', NOW);
      expect(prisma.demoRequest.update).toHaveBeenCalledWith({
        where: { id: 'dr1' },
        data: { status: 'NEW', handledAt: null },
      });
    });

    it('answers 404 for an unknown request', async () => {
      const { service, prisma } = setup();
      prisma.demoRequest.findUnique.mockResolvedValueOnce(null);
      await expect(service.updateStatus('nope', 'CLOSED', NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
