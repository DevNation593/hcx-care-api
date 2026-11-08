import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DemoRequest, DemoRequestStatus } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { demoRequestMail } from '../mail/mail.templates';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDemoRequestDto } from './dto/demo-request.dto';

const LIST_LIMIT = 200;

const notFound = () =>
  new NotFoundException({ code: 'DEMO_REQUEST_NOT_FOUND', message: 'Solicitud no encontrada' });

/**
 * Demo requests from the public site. Each one is saved and announced by e-mail to
 * DEMO_REQUEST_NOTIFY_EMAIL (comma-separated) or, without it, to the active administrators of the
 * platform tenant. The platform administrator then follows it up from /platform/demo-requests.
 */
@Injectable()
export class DemoRequestsService {
  private readonly logger = new Logger(DemoRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Returns nothing the visitor could use to tell a saved request from a dropped one. */
  async create(dto: CreateDemoRequestDto, now: Date = new Date()): Promise<{ received: true }> {
    if (dto.website) {
      // Honeypot filled in: a bot. Answer as usual so it learns nothing.
      this.logger.warn('Demo request dropped: honeypot field was filled');
      return { received: true };
    }

    const request = await this.prisma.demoRequest.create({
      data: {
        name: dto.name,
        clinic: dto.clinic,
        email: dto.email,
        phone: dto.phone,
        teamSize: dto.teamSize,
        message: dto.message || null,
        privacyAcceptedAt: now,
      },
    });

    await this.notify(request);
    return { received: true };
  }

  list(status?: DemoRequestStatus) {
    return this.prisma.demoRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
  }

  async updateStatus(id: string, status: DemoRequestStatus, now: Date = new Date()) {
    const current = await this.prisma.demoRequest.findUnique({ where: { id } });
    if (!current) throw notFound();

    return this.prisma.demoRequest.update({
      where: { id },
      data: {
        status,
        // Keeps the first time it was handled; going back to NEW clears it.
        handledAt: status === 'NEW' ? null : (current.handledAt ?? now),
      },
    });
  }

  private async notify(request: DemoRequest): Promise<void> {
    const recipients = await this.recipients();
    if (recipients.length === 0) {
      this.logger.warn(`Demo request ${request.id} saved, but there is no one to notify`);
      return;
    }

    const content = demoRequestMail({
      ...request,
      platformUrl: `${this.mail.webUrl}/platform/demo-requests`,
    });
    // MailService never throws; a failed notice must not lose the request, already saved.
    await Promise.all(recipients.map((to) => this.mail.send(to, content)));
  }

  private async recipients(): Promise<string[]> {
    const configured = (this.config.get<string>('DEMO_REQUEST_NOTIFY_EMAIL') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (configured.length) return configured;

    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', isActive: true, tenant: { isPlatform: true } },
      select: { email: true },
    });
    return admins.map((admin) => admin.email);
  }
}
