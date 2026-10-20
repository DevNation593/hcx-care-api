import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AestheticBookingStatus, Prisma } from '@prisma/client';
import { ClinicalCryptoService } from '../clinical-access/clinical-crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializableTransaction } from '../prisma/serializable-transaction';
import {
  CompleteAestheticSessionDto,
  CreateAestheticBookingDto,
  CreateAestheticClientDto,
  CreateAestheticServiceDto,
  CreateAestheticSessionDto,
  RecordAestheticConsentDto,
  UpdateAestheticBookingDto,
  UpdateAestheticClientDto,
  UpdateAestheticServiceDto,
} from './dto/aesthetics.dto';

const bookingInclude = {
  client: { select: { id: true, firstName: true, lastName: true } },
  service: { select: { id: true, name: true, durationMinutes: true } },
  staff: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AestheticBookingInclude;

const sessionInclude = {
  client: { select: { id: true, firstName: true, lastName: true } },
  service: { select: { id: true, name: true, consentText: true } },
  staff: { select: { id: true, firstName: true, lastName: true } },
  consent: true,
} satisfies Prisma.AestheticSessionInclude;

type SessionView = Prisma.AestheticSessionGetPayload<{ include: typeof sessionInclude }>;

@Injectable()
export class AestheticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: ClinicalCryptoService,
  ) {}

  listClients(tenantId: string) {
    return this.prisma.aestheticClient.findMany({
      where: { tenantId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  createClient(tenantId: string, input: CreateAestheticClientDto) {
    return this.prisma.aestheticClient.create({
      data: {
        tenantId,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email?.trim().toLowerCase(),
        phone: input.phone?.trim(),
      },
    });
  }

  async updateClient(tenantId: string, id: string, input: UpdateAestheticClientDto) {
    const updated = await this.prisma.aestheticClient.updateMany({
      where: { id, tenantId },
      data: {
        ...(input.firstName !== undefined && { firstName: input.firstName.trim() }),
        ...(input.lastName !== undefined && { lastName: input.lastName.trim() }),
        ...(input.email !== undefined && { email: input.email?.trim().toLowerCase() || null }),
        ...(input.phone !== undefined && { phone: input.phone?.trim() || null }),
      },
    });
    if (!updated.count) throw new NotFoundException('Cliente no encontrado');
    return this.prisma.aestheticClient.findFirst({ where: { id, tenantId } });
  }

  listServices(tenantId: string) {
    return this.prisma.aestheticService.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
  }

  createService(tenantId: string, input: CreateAestheticServiceDto) {
    return this.prisma.aestheticService.create({
      data: {
        tenantId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        durationMinutes: input.durationMinutes,
        price: input.price,
        consentText: input.consentText?.trim() || null,
      },
    });
  }

  async updateService(tenantId: string, id: string, input: UpdateAestheticServiceDto) {
    const updated = await this.prisma.aestheticService.updateMany({
      where: { id, tenantId },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.description !== undefined && { description: input.description.trim() || null }),
        ...(input.durationMinutes !== undefined && { durationMinutes: input.durationMinutes }),
        ...(input.price !== undefined && { price: input.price }),
        ...(input.consentText !== undefined && { consentText: input.consentText.trim() || null }),
      },
    });
    if (!updated.count) throw new NotFoundException('Servicio no encontrado');
    return this.prisma.aestheticService.findFirst({ where: { id, tenantId } });
  }

  listBookings(tenantId: string, from?: string, to?: string) {
    return this.prisma.aestheticBooking.findMany({
      where: {
        tenantId,
        ...(from || to
          ? { startAt: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } }
          : {}),
      },
      include: bookingInclude,
      orderBy: { startAt: 'asc' },
    });
  }

  createBooking(tenantId: string, input: CreateAestheticBookingDto, actorId: string) {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      await this.assertClient(tx, tenantId, input.clientId);
      const service = await this.assertService(tx, tenantId, input.serviceId);
      await this.assertStaff(tx, tenantId, input.staffId);
      const startAt = new Date(input.startAt);
      if (!Number.isFinite(startAt.getTime()) || startAt <= new Date()) {
        throw new BadRequestException('La cita debe tener una fecha futura.');
      }
      const endAt = new Date(startAt.getTime() + service.durationMinutes * 60_000);
      await this.assertBookingAvailable(tx, tenantId, input.staffId, startAt, endAt);
      return tx.aestheticBooking.create({
        data: {
          tenantId,
          clientId: input.clientId,
          serviceId: input.serviceId,
          staffId: input.staffId,
          startAt,
          endAt,
        },
        include: bookingInclude,
      });
    });
  }

  updateBooking(tenantId: string, id: string, input: UpdateAestheticBookingDto, actorId: string) {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const current = await tx.aestheticBooking.findFirst({
        where: { id, tenantId },
        include: { service: true },
      });
      if (!current) throw new NotFoundException('Cita no encontrada');
      if (current.status === AestheticBookingStatus.COMPLETED) {
        throw new ConflictException('Una cita completada no puede modificarse.');
      }
      if (input.status === AestheticBookingStatus.COMPLETED) {
        throw new ConflictException('Completa la sesión para finalizar la cita.');
      }
      const linkedSession = await tx.aestheticSession.findFirst({
        where: { tenantId, bookingId: id },
        select: { id: true },
      });
      if (
        linkedSession &&
        (input.status === AestheticBookingStatus.CANCELLED || input.startAt || input.staffId)
      ) {
        throw new ConflictException(
          'Una cita con sesión iniciada no puede cancelarse o reprogramarse.',
        );
      }
      const staffId = input.staffId ?? current.staffId;
      const nextStatus = input.status ?? current.status;
      const reactivating =
        current.status === AestheticBookingStatus.CANCELLED &&
        nextStatus === AestheticBookingStatus.SCHEDULED;
      if (input.staffId || reactivating) await this.assertStaff(tx, tenantId, staffId);
      const startAt = input.startAt ? new Date(input.startAt) : current.startAt;
      const endAt = new Date(startAt.getTime() + current.service.durationMinutes * 60_000);
      if (
        (input.startAt || input.staffId || reactivating) &&
        nextStatus === AestheticBookingStatus.SCHEDULED
      ) {
        if (startAt <= new Date())
          throw new BadRequestException('La cita debe tener una fecha futura.');
        await this.assertBookingAvailable(tx, tenantId, staffId, startAt, endAt, id);
      }
      return tx.aestheticBooking.update({
        where: { id },
        data: { staffId, startAt, endAt, ...(input.status && { status: input.status }) },
        include: bookingInclude,
      });
    });
  }

  async listSessions(tenantId: string, clientId?: string) {
    const rows = await this.prisma.aestheticSession.findMany({
      where: { tenantId, ...(clientId && { clientId }) },
      include: sessionInclude,
      orderBy: { startedAt: 'desc' },
    });
    return rows.map((row) => this.presentSession(tenantId, row));
  }

  createSession(tenantId: string, input: CreateAestheticSessionDto, actorId: string) {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      await this.assertClient(tx, tenantId, input.clientId);
      await this.assertService(tx, tenantId, input.serviceId);
      await this.assertStaff(tx, tenantId, input.staffId);
      if (input.bookingId) {
        const booking = await tx.aestheticBooking.findFirst({
          where: {
            id: input.bookingId,
            tenantId,
            status: AestheticBookingStatus.SCHEDULED,
          },
        });
        if (
          !booking ||
          booking.clientId !== input.clientId ||
          booking.serviceId !== input.serviceId ||
          booking.staffId !== input.staffId
        ) {
          throw new BadRequestException(
            'La cita no corresponde al cliente, servicio y profesional.',
          );
        }
        const existing = await tx.aestheticSession.findFirst({
          where: { tenantId, bookingId: input.bookingId },
        });
        if (existing) throw new ConflictException('Esta cita ya tiene una sesión.');
      }
      const row = await tx.aestheticSession.create({
        data: {
          tenantId,
          clientId: input.clientId,
          serviceId: input.serviceId,
          staffId: input.staffId,
          bookingId: input.bookingId,
          notes: input.notes?.trim() ? this.encryptSensitive(tenantId, input.notes.trim()) : null,
        },
        include: sessionInclude,
      });
      return this.presentSession(tenantId, row);
    });
  }

  completeSession(
    tenantId: string,
    id: string,
    input: CompleteAestheticSessionDto,
    actorId: string,
  ) {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const row = await tx.aestheticSession.findFirst({
        where: { id, tenantId },
        include: { service: true, consent: true },
      });
      if (!row) throw new NotFoundException('Sesión no encontrada');
      if (row.completedAt) throw new ConflictException('La sesión ya está completada.');
      if (row.service.consentText && !row.consent) {
        throw new ConflictException('Registra el consentimiento antes de completar la sesión.');
      }
      if (row.bookingId) {
        const result = await tx.aestheticBooking.updateMany({
          where: { id: row.bookingId, tenantId, status: AestheticBookingStatus.SCHEDULED },
          data: { status: AestheticBookingStatus.COMPLETED },
        });
        if (!result.count)
          throw new ConflictException('La cita de esta sesión ya no está programada.');
      }
      const updated = await tx.aestheticSession.update({
        where: { id },
        data: {
          completedAt: new Date(),
          ...(input.notes !== undefined && {
            notes: input.notes.trim() ? this.encryptSensitive(tenantId, input.notes.trim()) : null,
          }),
        },
        include: sessionInclude,
      });
      return this.presentSession(tenantId, updated);
    });
  }

  async listConsents(tenantId: string) {
    const rows = await this.prisma.aestheticConsent.findMany({
      where: { tenantId },
      include: { session: { include: { client: true, service: true } } },
      orderBy: { acceptedAt: 'desc' },
    });
    return rows.map((row) => this.presentConsent(tenantId, row));
  }

  recordConsent(
    tenantId: string,
    sessionId: string,
    input: RecordAestheticConsentDto,
    actorId: string,
  ) {
    return runSerializableTransaction(this.prisma, tenantId, actorId, async (tx) => {
      const session = await tx.aestheticSession.findFirst({
        where: { id: sessionId, tenantId },
        include: { service: true },
      });
      if (!session) throw new NotFoundException('Sesión no encontrada');
      if (session.completedAt) {
        throw new ConflictException('Una sesión completada no admite nuevos consentimientos.');
      }
      if (!session.service.consentText?.trim()) {
        throw new BadRequestException('El servicio no tiene un texto de consentimiento.');
      }
      if (session.service.consentText !== input.expectedConsentText) {
        throw new ConflictException(
          'El texto de consentimiento cambió. Revísalo antes de registrar la aceptación.',
        );
      }
      const existing = await tx.aestheticConsent.findFirst({ where: { tenantId, sessionId } });
      if (existing) throw new ConflictException('La sesión ya tiene un consentimiento registrado.');
      const row = await tx.aestheticConsent.create({
        data: {
          tenantId,
          sessionId,
          bodySnapshot: this.encryptSensitive(tenantId, session.service.consentText),
          signerName: this.encryptSensitive(tenantId, input.signerName.trim()),
          acceptedAt: new Date(),
          recordedById: actorId,
        },
      });
      return this.presentConsent(tenantId, row);
    });
  }

  private async assertClient(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const client = await tx.aestheticClient.findFirst({ where: { id, tenantId, isActive: true } });
    if (!client) throw new NotFoundException('Cliente no encontrado');
  }

  private encryptSensitive(tenantId: string, value: string): string {
    if (!this.crypto.enabled) {
      throw new ServiceUnavailableException('La clave de cifrado no está configurada.');
    }
    return this.crypto.encrypt(tenantId, value);
  }

  private async assertService(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const service = await tx.aestheticService.findFirst({
      where: { id, tenantId, isActive: true },
    });
    if (!service) throw new NotFoundException('Servicio no encontrado');
    return service;
  }

  private async assertStaff(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    const staff = await tx.user.findFirst({
      where: { id, tenantId, isActive: true, role: { in: ['MASTER', 'PROFESIONAL'] } },
    });
    if (!staff) throw new NotFoundException('Profesional no encontrado');
  }

  private async assertBookingAvailable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    staffId: string,
    startAt: Date,
    endAt: Date,
    excludingId?: string,
  ) {
    const conflict = await tx.aestheticBooking.findFirst({
      where: {
        tenantId,
        staffId,
        status: AestheticBookingStatus.SCHEDULED,
        startAt: { lt: endAt },
        endAt: { gt: startAt },
        ...(excludingId && { id: { not: excludingId } }),
      },
    });
    if (conflict) throw new ConflictException('El profesional ya tiene una cita en ese horario.');
  }

  private presentSession(tenantId: string, row: SessionView) {
    return {
      ...row,
      notes: row.notes ? this.crypto.decrypt(tenantId, row.notes) : null,
      consent: row.consent ? this.presentConsent(tenantId, row.consent) : null,
    };
  }

  private presentConsent<T extends { bodySnapshot: string; signerName: string }>(
    tenantId: string,
    row: T,
  ): T {
    return {
      ...row,
      bodySnapshot: this.crypto.decrypt(tenantId, row.bodySnapshot),
      signerName: this.crypto.decrypt(tenantId, row.signerName),
    };
  }
}
