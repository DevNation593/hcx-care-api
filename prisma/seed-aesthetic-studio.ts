import { randomUUID } from 'crypto';
import type {
  AestheticBookingStatus,
  AestheticClient,
  AestheticPhotoPhase,
  AestheticService,
  AestheticSession,
  Prisma,
  User,
} from '@prisma/client';
import { demoSkinPhoto } from './seed-demo-files';
import {
  createTenant,
  createUser,
  SeedContext,
  SeedTenant,
  Slot,
  syncUsage,
  withTenantContext,
} from './seed-helpers';

const PEELING_CONSENT =
  'Entiendo que el peeling químico puede causar enrojecimiento, descamación y sensibilidad durante ' +
  'varios días. Me comprometo a usar protector solar y a no exponerme al sol durante una semana.';
const LASER_CONSENT =
  'Declaro no estar embarazada ni usar medicación fotosensibilizante. Entiendo que el láser puede ' +
  'causar enrojecimiento temporal y que se requieren varias sesiones para un resultado estable.';

/**
 * An aesthetic studio: its own clients, services, agenda, sessions, consents and before/after
 * photos, and none of the medical sections. Clinical text and photo bytes are stored as the
 * API stores them: encrypted when a key is configured.
 */
export async function seedAestheticStudio(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const studio = await createTenant(ctx, {
    name: 'Estudio Estético Aurora',
    email: 'contacto@esteticaaurora.ec',
    phone: '+593 2 245 7788',
    address: 'Av. República de El Salvador N35-12, Quito',
    tenantType: 'CLINIC',
    businessKind: 'AESTHETIC_STUDIO',
    planType: 'CLINIC_BASIC',
    status: 'ACTIVE',
    specialties: [],
    fiscal: {
      legalName: 'Estética Aurora Cía. Ltda.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1793187654001',
    },
    master: {
      email: 'titular.aurora@psic.com',
      firstName: 'Andrea',
      lastName: 'Molina',
      phone: '+593 99 410 2233',
      note: 'Titular del estudio estético; también atiende y ve las fotos',
    },
  });
  const tenantId = studio.tenant.id;
  const andrea = studio.master;

  const lucia = await createUser(ctx, studio, {
    email: 'cosmiatra.aurora@psic.com',
    firstName: 'Lucía',
    lastName: 'Paredes',
    role: 'PROFESIONAL',
    note: 'Cosmiatra: registra sesiones, consentimientos y fotos de antes y después',
  });
  const sofia = await createUser(ctx, studio, {
    email: 'esteticista.aurora@psic.com',
    firstName: 'Sofía',
    lastName: 'Cárdenas',
    role: 'PROFESIONAL',
    note: 'Esteticista con agenda propia',
  });
  const daniel = await createUser(ctx, studio, {
    email: 'recepcion.aurora@psic.com',
    firstName: 'Daniel',
    lastName: 'Ortiz',
    role: 'ASISTENTE',
    note: 'Recepción; su rol también registra consentimientos, sin ver fotos',
  });

  // Set from the platform panel: the front desk collects the consent before the session.
  await ctx.db.tenantRolePermission.create({
    data: {
      tenantId,
      role: 'ASISTENTE',
      permission: 'aesthetics.consents.manage',
      granted: true,
      createdById: ctx.platformAdminId,
    },
  });

  const protect = (value: string) => (ctx.cipher ? ctx.cipher.encrypt(tenantId, value) : value);
  let storedBytes = 0;

  await withTenantContext(ctx.db, tenantId, async (tx) => {
    const service = (data: Omit<Prisma.AestheticServiceUncheckedCreateInput, 'tenantId'>) =>
      tx.aestheticService.create({ data: { tenantId, ...data } });
    const facial = await service({
      name: 'Limpieza facial profunda',
      description: 'Extracción, exfoliación y mascarilla hidratante.',
      durationMinutes: 60,
      price: 35,
    });
    const peeling = await service({
      name: 'Peeling químico superficial',
      description: 'Ácido glicólico al 30 % para manchas y textura.',
      durationMinutes: 45,
      price: 60,
      consentText: PEELING_CONSENT,
    });
    const laser = await service({
      name: 'Depilación láser de axilas',
      durationMinutes: 30,
      price: 45,
      consentText: LASER_CONSENT,
    });
    const microderm = await service({
      name: 'Microdermoabrasión',
      description: 'Exfoliación mecánica con punta de diamante.',
      durationMinutes: 45,
      price: 50,
    });
    // Out of the menu: it keeps its history and takes no new bookings.
    await service({
      name: 'Radiofrecuencia corporal',
      durationMinutes: 60,
      price: 70,
      isActive: false,
    });

    const client = (data: Omit<Prisma.AestheticClientUncheckedCreateInput, 'tenantId'>) =>
      tx.aestheticClient.create({ data: { tenantId, createdAt: clock.days(-60), ...data } });
    const valentina = await client({
      firstName: 'Valentina',
      lastName: 'Ríos',
      email: 'valentina.rios@example.com',
      phone: '+593 98 112 3344',
    });
    const camila = await client({
      firstName: 'Camila',
      lastName: 'Torres',
      email: 'camila.torres@example.com',
      phone: '+593 98 223 4455',
    });
    const gabriela = await client({
      firstName: 'Gabriela',
      lastName: 'Suárez',
      phone: '+593 98 334 5566',
    });
    const isabel = await client({
      firstName: 'Isabel',
      lastName: 'Moreno',
      email: 'isabel.moreno@example.com',
    });
    const mariana = await client({
      firstName: 'Mariana',
      lastName: 'Vega',
      email: 'mariana.vega@example.com',
      phone: '+593 98 445 6677',
    });
    // No longer a client: her history stays, she cannot be booked again.
    const paula = await client({ firstName: 'Paula', lastName: 'Herrera', isActive: false });

    const booking = (
      who: AestheticClient,
      what: AestheticService,
      staff: User,
      slot: Slot,
      status: AestheticBookingStatus,
    ) =>
      tx.aestheticBooking.create({
        data: {
          tenantId,
          clientId: who.id,
          serviceId: what.id,
          staffId: staff.id,
          startAt: slot.startTime,
          endAt: slot.endTime,
          status,
          createdAt: clock.days(-21),
        },
      });
    const slot = (staff: User, dayOffset: number, time: string, what: AestheticService) =>
      studio.agenda.book(staff.id, dayOffset, time, what.durationMinutes);

    const session = (input: {
      who: AestheticClient;
      what: AestheticService;
      staff: User;
      startedAt: Date;
      completedAt?: Date;
      bookingId?: string;
      notes?: string;
    }) =>
      tx.aestheticSession.create({
        data: {
          tenantId,
          clientId: input.who.id,
          serviceId: input.what.id,
          staffId: input.staff.id,
          bookingId: input.bookingId,
          startedAt: input.startedAt,
          completedAt: input.completedAt,
          notes: input.notes ? protect(input.notes) : null,
          createdAt: input.startedAt,
        },
      });
    const consent = (of: AestheticSession, what: AestheticService, signer: string, by: User) =>
      tx.aestheticConsent.create({
        data: {
          tenantId,
          sessionId: of.id,
          bodySnapshot: protect(what.consentText),
          signerName: protect(signer),
          acceptedAt: new Date(of.startedAt.getTime() - 5 * 60 * 1000),
          recordedById: by.id,
          createdAt: of.startedAt,
        },
      });
    /** A photo with its bytes in the storage. Skipped when the seed has no storage. */
    const photo = async (of: AestheticSession, phase: AestheticPhotoPhase, by: User, at: Date) => {
      if (!ctx.storage) return;
      const bytes = demoSkinPhoto(phase);
      const storageKey = `${tenantId}/aesthetics/${of.id}/${randomUUID()}`;
      await ctx.storage.put(
        storageKey,
        ctx.cipher ? ctx.cipher.encryptBuffer(tenantId, bytes) : bytes,
      );
      storedBytes += bytes.length;
      await tx.aestheticPhoto.create({
        data: {
          tenantId,
          sessionId: of.id,
          uploadedById: by.id,
          phase,
          mimeType: 'image/png',
          sizeBytes: bytes.length,
          storageKey,
          createdAt: at,
        },
      });
    };

    // ------------------------------------------------------------------ past, completed
    // Peeling with everything: booking, consent taken at the front desk, before and after photos.
    const peelingSlot = slot(lucia, -14, '10:00', peeling);
    const peelingBooking = await booking(valentina, peeling, lucia, peelingSlot, 'COMPLETED');
    const peelingSession = await session({
      who: valentina,
      what: peeling,
      staff: lucia,
      bookingId: peelingBooking.id,
      startedAt: peelingSlot.startTime,
      completedAt: peelingSlot.endTime,
      notes: 'Fototipo III. Tolera bien el ácido; eritema leve al retirar. Control en 15 días.',
    });
    await consent(peelingSession, peeling, 'Valentina Ríos', daniel);
    await photo(peelingSession, 'BEFORE', lucia, peelingSlot.startTime);
    await photo(peelingSession, 'AFTER', lucia, peelingSlot.endTime);

    // A service without consent text: the session closes without one.
    const facialSlot = slot(sofia, -7, '15:00', facial);
    const facialBooking = await booking(camila, facial, sofia, facialSlot, 'COMPLETED');
    await session({
      who: camila,
      what: facial,
      staff: sofia,
      bookingId: facialBooking.id,
      startedAt: facialSlot.startTime,
      completedAt: facialSlot.endTime,
      notes: 'Piel mixta con comedones en zona T. Se recomienda limpieza mensual.',
    });

    // Laser by the owner: consent recorded by herself and only the photo before the session.
    const laserSlot = slot(andrea, -3, '11:00', laser);
    const laserBooking = await booking(gabriela, laser, andrea, laserSlot, 'COMPLETED');
    const laserSession = await session({
      who: gabriela,
      what: laser,
      staff: andrea,
      bookingId: laserBooking.id,
      startedAt: laserSlot.startTime,
      completedAt: laserSlot.endTime,
      notes: 'Sesión 1 de 6. Fluencia 18 J/cm². Sin reacciones adversas.',
    });
    await consent(laserSession, laser, 'Gabriela Suárez', andrea);
    await photo(laserSession, 'BEFORE', andrea, laserSlot.startTime);

    // Walk-in: a session with no booking behind it.
    await session({
      who: isabel,
      what: facial,
      staff: sofia,
      startedAt: clock.at(-10, '12:00'),
      completedAt: clock.at(-10, '13:00'),
    });

    // History of a client who is no longer active.
    await session({
      who: paula,
      what: microderm,
      staff: sofia,
      startedAt: clock.at(-30, '09:00'),
      completedAt: clock.at(-30, '09:45'),
      notes: 'Última sesión antes de mudarse de ciudad.',
    });

    // Cancelled by the client the day before.
    await booking(isabel, microderm, sofia, slot(sofia, -2, '16:00', microderm), 'CANCELLED');

    // ------------------------------------------------------------------ in progress
    // Started twenty minutes ago without a consent: it cannot be completed until one is recorded.
    const nowSlot = studio.agenda.reserve(lucia.id, clock.minutes(-20), peeling.durationMinutes);
    const nowBooking = await booking(mariana, peeling, lucia, nowSlot, 'SCHEDULED');
    await session({
      who: mariana,
      what: peeling,
      staff: lucia,
      bookingId: nowBooking.id,
      startedAt: nowSlot.startTime,
    });

    // ------------------------------------------------------------------ upcoming
    await booking(gabriela, microderm, andrea, slot(andrea, 1, '09:00', microderm), 'SCHEDULED');
    await booking(valentina, facial, sofia, slot(sofia, 2, '10:00', facial), 'SCHEDULED');
    await booking(camila, laser, lucia, slot(lucia, 5, '17:00', laser), 'SCHEDULED');
  });

  await syncUsage(ctx, studio);
  if (storedBytes > 0) {
    await ctx.db.tenantSubscription.update({
      where: { tenantId },
      data: { storageUsedBytes: BigInt(storedBytes) },
    });
  }

  ctx.highlights.push(
    `${studio.tenant.name}: estudio estético sin módulos médicos — una sesión en curso esperando consentimiento, fotos de antes y después y tres citas próximas.`,
  );
  if (!ctx.storage) {
    ctx.highlights.push(
      `${studio.tenant.name}: sin almacenamiento configurado no se sembraron las fotos.`,
    );
  }
  return studio;
}
