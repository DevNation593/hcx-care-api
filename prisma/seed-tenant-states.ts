import type { Prisma, User } from '@prisma/client';
import { upgradeCharge } from '../src/subscription/subscription-billing.rules';
import {
  createAppointment,
  createPatient,
  createTenant,
  createUser,
  planSubscriptionData,
  SeedContext,
  SeedTenant,
  syncUsage,
  writeAudit,
} from './seed-helpers';

const PATIENT_NAMES = [
  'Daniel Rosero',
  'Carolina Vega',
  'Esteban Mora',
  'Fernanda Lasso',
  'Gonzalo Pinto',
  'Helena Duarte',
  'Ignacio Cisneros',
  'Julia Carrasco',
  'Kevin Zambrano',
  'Lorena Calle',
  'Marco Aguirre',
  'Noelia Paz',
];

/** Patients for one professional; the first three also get a past session and a next visit. */
async function seedCaseload(
  ctx: SeedContext,
  clinic: SeedTenant,
  professional: User,
  count: number,
  offset = 0,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const [firstName, lastName] = PATIENT_NAMES[(offset + index) % PATIENT_NAMES.length].split(' ');
    const patient = await createPatient(
      ctx,
      clinic,
      {
        firstName,
        lastName,
        email: `${firstName}.${lastName}@email.com`.toLowerCase(),
        phone: `+5939992${String(offset * 20 + index).padStart(5, '0')}`,
      },
      { current: [professional] },
    );
    if (index >= 3) continue;

    const past = await createAppointment(ctx, clinic, {
      patient,
      professional,
      slot: clinic.agenda.book(professional.id, -(3 + index), '10:00'),
      status: 'COMPLETED',
      title: 'Consulta de seguimiento',
    });
    await ctx.db.clinicalNote.create({
      data: {
        tenantId: clinic.tenant.id,
        patientId: patient.id,
        psychologistId: professional.id,
        specialtyId: clinic.specialtyOf.get(professional.id),
        appointmentId: past.id,
        content: 'Consulta de seguimiento. Evolución favorable; se mantienen las indicaciones.',
        sessionDate: past.startTime,
        sessionDuration: past.duration,
      },
    });
    await createAppointment(ctx, clinic, {
      patient,
      professional,
      slot: clinic.agenda.book(professional.id, 2 + index, '10:00'),
      status: 'SCHEDULED',
      title: 'Consulta de seguimiento',
    });
  }
}

const events = (
  ctx: SeedContext,
  clinic: SeedTenant,
  data: Omit<Prisma.SubscriptionEventCreateManyInput, 'tenantId'>[],
) =>
  ctx.db.subscriptionEvent.createMany({
    data: data.map((event) => ({ tenantId: clinic.tenant.id, ...event })),
  });

const payments = (
  ctx: SeedContext,
  clinic: SeedTenant,
  data: Omit<Prisma.SubscriptionPaymentCreateManyInput, 'tenantId'>[],
) =>
  ctx.db.subscriptionPayment.createMany({
    data: data.map((payment) => ({ tenantId: clinic.tenant.id, ...payment })),
  });

/** Day 4 of the trial, run by its holder alone, with the trial's patient quota used up. */
async function seedPersonalTrial(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const clinic = await createTenant(ctx, {
    name: 'Demo Consultorio Personal',
    email: 'contacto@demopersonal.com',
    phone: '+593999200001',
    tenantType: 'PERSONAL',
    onboardingCompleted: false,
    fiscal: {
      legalName: 'Demo Consultorio Personal',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1790012345002',
    },
    settings: { workingHoursEnd: '17:00', reminderRules: ['24h'] },
    planType: 'TRIAL',
    status: 'TRIALING',
    subscription: {
      startDate: clock.days(-4),
      trialEndsAt: clock.days(10),
      currentPeriodStart: clock.days(-4),
      currentPeriodEnd: null,
      storageUsedBytes: BigInt(50 * 1024 * 1024),
      monthlyNotificationsSent: 8,
    },
    specialties: ['psychology'],
    master: {
      email: 'admin.trial@psic.com',
      firstName: 'Carla',
      lastName: 'Noboa',
      note: 'Titular que también atiende; prueba en curso con el cupo de pacientes lleno (10/10)',
      profile: { specialty: 'psychology', title: 'Psicóloga clínica', licenseNumber: 'PSY-EC-010' },
      data: { activatedAt: clock.days(-4) },
    },
  });
  await seedCaseload(ctx, clinic, clinic.master, clinic.subscription.maxActivePatients);
  await events(ctx, clinic, [
    {
      eventType: 'TRIAL_STARTED',
      newPlan: 'TRIAL',
      newStatus: 'TRIALING',
      createdAt: clock.days(-4),
    },
    {
      eventType: 'LIMIT_REACHED',
      previousPlan: 'TRIAL',
      newPlan: 'TRIAL',
      reason: 'Se alcanzó el límite de pacientes activos del plan.',
      metadata: { limit: 'maxActivePatients', used: 10, max: 10 },
      createdAt: clock.hours(-3),
    },
  ]);
  return clinic;
}

/** A paid personal plan in good standing that never configured invoicing. */
async function seedPersonalBasic(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const clinic = await createTenant(ctx, {
    name: 'Nutrición Vital',
    email: 'contacto@nutricionvital.test',
    tenantType: 'PERSONAL',
    fiscal: {
      legalName: 'Andrea Salas Mora',
      taxIdentificationType: 'CEDULA',
      taxIdentificationNumber: '1710034065',
    },
    settings: { timezone: 'America/Mexico_City', locale: 'es-MX', reminderEnabled: false },
    planType: 'PERSONAL_BASIC',
    status: 'ACTIVE',
    subscription: {
      startDate: clock.days(-72),
      currentPeriodStart: clock.days(-12),
      currentPeriodEnd: clock.days(18),
    },
    specialties: ['nutrition'],
    master: {
      email: 'titular.nutricion@psic.com',
      firstName: 'Andrea',
      lastName: 'Salas',
      note: 'Consultorio personal al día; sin facturación configurada y con recordatorios apagados',
      profile: {
        specialty: 'nutrition',
        title: 'Nutricionista clínica',
        licenseNumber: 'NUT-EC-011',
      },
    },
  });
  await seedCaseload(ctx, clinic, clinic.master, 3, 1);
  await payments(ctx, clinic, [
    {
      kind: 'RENEWAL',
      status: 'CONFIRMED',
      amount: Number(clinic.subscription.basePrice),
      targetPlan: 'PERSONAL_BASIC',
      periodStart: clock.days(-12),
      periodEnd: clock.days(18),
      providerReference: ctx.nextPaymentReference(),
      resolvedById: ctx.platformAdminId,
      resolvedAt: clock.days(-13),
      createdAt: clock.days(-19),
    },
  ]);
  await events(ctx, clinic, [
    {
      eventType: 'SUBSCRIPTION_ACTIVATED',
      newPlan: 'PERSONAL_BASIC',
      newStatus: 'ACTIVE',
      triggeredByUserId: ctx.platformAdminId,
      createdAt: clock.days(-72),
    },
    {
      eventType: 'PAYMENT_SUCCEEDED',
      previousStatus: 'ACTIVE',
      newStatus: 'ACTIVE',
      metadata: { kind: 'RENEWAL', amount: Number(clinic.subscription.basePrice) },
      triggeredByUserId: ctx.platformAdminId,
      createdAt: clock.days(-13),
    },
  ]);
  return clinic;
}

/** Paid add-ons on top of the plan, sections switched off by the platform, storage almost full. */
async function seedPersonalPro(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const clinic = await createTenant(ctx, {
    name: 'Psicoterapia Online Larrea',
    email: 'contacto@psicoterapialarrea.test',
    tenantType: 'PERSONAL',
    fiscal: {
      legalName: 'Esteban Larrea Proaño',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1710034065001',
    },
    planType: 'PERSONAL_PRO',
    status: 'ACTIVE',
    subscription: {
      startDate: clock.days(-110),
      currentPeriodStart: clock.days(-20),
      currentPeriodEnd: clock.days(10),
      storageUsedBytes: BigInt(980 * 1024 * 1024),
    },
    specialties: ['psychology'],
    addOns: ['apiAccess', 'whatsAppIntegration'],
    disabledSections: ['core.billing', 'core.patients.files'],
    disabledModules: ['psychology.assessments'],
    master: {
      email: 'titular.online@psic.com',
      firstName: 'Esteban',
      lastName: 'Larrea',
      note: 'Plan con módulos de pago añadidos; facturación, almacenamiento y un módulo clínico desactivados',
      profile: { specialty: 'psychology', title: 'Psicoterapeuta', licenseNumber: 'PSY-EC-012' },
    },
  });
  await seedCaseload(ctx, clinic, clinic.master, 3, 2);
  await events(ctx, clinic, [
    {
      eventType: 'FEATURE_ENABLED',
      previousPlan: 'PERSONAL_PRO',
      newPlan: 'PERSONAL_PRO',
      metadata: {
        addons: [
          { module: 'apiAccess', price: 15 },
          { module: 'whatsAppIntegration', price: 10 },
          { module: 'sso', price: 20 },
        ],
      },
      triggeredByUserId: clinic.master.id,
      createdAt: clock.days(-50),
    },
    {
      eventType: 'FEATURE_DISABLED',
      previousPlan: 'PERSONAL_PRO',
      newPlan: 'PERSONAL_PRO',
      reason: 'El titular retiró el inicio de sesión único.',
      metadata: { removed: ['sso'] },
      triggeredByUserId: clinic.master.id,
      createdAt: clock.days(-21),
    },
  ]);
  await writeAudit(ctx, clinic, {
    actor: { id: ctx.platformAdminId },
    action: 'UPDATE',
    entity: 'TENANT',
    entityId: clinic.tenant.id,
    before: { sections: { 'core.billing': true, 'core.patients.files': true } },
    after: { sections: { 'core.billing': false, 'core.patients.files': false } },
    reason: 'El consultorio factura con otro sistema y no usa archivos.',
    at: clock.days(-40),
  });
  return clinic;
}

/**
 * A clinic at its limits: every seat taken, the month's invoice quota used and an upgrade
 * waiting for payment, after one request expired, one was rejected and one was replaced.
 */
async function seedClinicAtLimits(ctx: SeedContext): Promise<SeedTenant> {
  const { db, clock } = ctx;
  const clinic = await createTenant(ctx, {
    name: 'Centro Terapéutico Andes',
    email: 'contacto@centroandes.test',
    phone: '+593999300001',
    address: 'Av. de los Shyris 2210, Quito',
    tenantType: 'CLINIC',
    fiscal: {
      legalName: 'Centro Terapéutico Andes Cía. Ltda.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1792345678001',
    },
    planType: 'CLINIC_BASIC',
    status: 'ACTIVE',
    subscription: {
      startDate: clock.days(-130),
      currentPeriodStart: clock.days(-10),
      currentPeriodEnd: clock.days(20),
      monthlyElectronicInvoicesLimit: 3,
    },
    specialties: ['psychology', 'physiotherapy'],
    master: {
      email: 'titular.andes@psic.com',
      firstName: 'Ricardo',
      lastName: 'Paz',
      note: 'Clínica con los 3 cupos ocupados, la cuota de facturas agotada y una mejora esperando pago',
    },
  });
  const tenantId = clinic.tenant.id;

  const natalia = await createUser(ctx, clinic, {
    email: 'psic.andes@psic.com',
    firstName: 'Natalia',
    lastName: 'Bravo',
    role: 'PROFESIONAL',
    note: 'Profesional activa (psicología)',
    profile: { specialty: 'psychology', title: 'Psicóloga clínica', licenseNumber: 'PSY-EC-020' },
  });
  const oscar = await createUser(ctx, clinic, {
    email: 'fisio.andes@psic.com',
    firstName: 'Óscar',
    lastName: 'Molina',
    role: 'PROFESIONAL',
    note: 'Profesional activo (fisioterapia)',
    profile: { specialty: 'physiotherapy', title: 'Fisioterapeuta', licenseNumber: 'FIS-EC-021' },
  });
  await createUser(ctx, clinic, {
    email: 'psic2.andes@psic.com',
    firstName: 'Irene',
    lastName: 'Castro',
    role: 'PROFESIONAL',
    note: 'Profesional activa; ocupa el último cupo del plan',
    profile: { specialty: 'psychology', title: 'Psicóloga educativa', licenseNumber: 'PSY-EC-022' },
  });
  await createUser(ctx, clinic, {
    email: 'asistente.andes@psic.com',
    firstName: 'Silvia',
    lastName: 'Reyes',
    role: 'ASISTENTE',
    note: 'Asistente',
  });
  await seedCaseload(ctx, clinic, natalia, 2, 3);
  await seedCaseload(ctx, clinic, oscar, 2, 4);

  const issuedAt = [clock.minutes(-30), clock.minutes(-20), clock.minutes(-10)];
  await db.invoice.createMany({
    data: issuedAt.map((issueDate, index) => ({
      tenantId,
      issuerId: clinic.master.id,
      status: 'ISSUED' as const,
      issueDate,
      subtotal: 35,
      total: 35,
      customerName: 'Consumidor de prueba',
      customerEmail: `cliente${index + 1}@email.com`,
      customerTaxIdType: 'CEDULA',
      customerTaxId: `170000000${index + 1}`,
      description: 'Sesión de fisioterapia',
      externalId: `fk_test_andes_${index + 1}`,
      idempotencyKey: `${tenantId}:seed-invoice-${index + 1}`,
      createdAt: issueDate,
    })),
  });
  clinic.usage.invoicesThisMonth = issuedAt.filter((date) => date >= clock.monthStart()).length;

  const proPrice = planSubscriptionData('CLINIC_PRO', 2).basePrice;
  await payments(ctx, clinic, [
    {
      kind: 'RENEWAL',
      status: 'CONFIRMED',
      amount: Number(clinic.subscription.basePrice),
      targetPlan: 'CLINIC_BASIC',
      periodStart: clock.days(-10),
      periodEnd: clock.days(20),
      providerReference: ctx.nextPaymentReference(),
      resolvedById: ctx.platformAdminId,
      resolvedAt: clock.days(-11),
      createdAt: clock.days(-17),
    },
    {
      kind: 'PLAN_UPGRADE',
      status: 'EXPIRED',
      amount: 86.67,
      targetPlan: 'CLINIC_PRO',
      requestedById: clinic.master.id,
      expiresAt: clock.days(-33),
      resolvedAt: clock.days(-33),
      resolutionNote: 'No se confirmó el pago a tiempo',
      createdAt: clock.days(-40),
    },
    {
      kind: 'PLAN_UPGRADE',
      status: 'REJECTED',
      amount: 93.33,
      targetPlan: 'CLINIC_PRO',
      requestedById: clinic.master.id,
      resolvedById: ctx.platformAdminId,
      resolvedAt: clock.days(-24),
      resolutionNote: 'El comprobante no corresponde al monto solicitado.',
      expiresAt: clock.days(-18),
      createdAt: clock.days(-25),
    },
    {
      kind: 'PLAN_UPGRADE',
      status: 'CANCELED',
      amount: 96.67,
      targetPlan: 'CLINIC_PRO',
      requestedById: clinic.master.id,
      resolvedAt: clock.days(-1),
      resolutionNote: 'Reemplazada por una solicitud más reciente',
      expiresAt: clock.days(-2),
      createdAt: clock.days(-9),
    },
    {
      kind: 'PLAN_UPGRADE',
      status: 'PENDING',
      amount: upgradeCharge(clinic.subscription, proPrice, clock.days(-1)),
      targetPlan: 'CLINIC_PRO',
      requestedById: clinic.master.id,
      expiresAt: clock.days(6),
      createdAt: clock.days(-1),
    },
  ]);
  await events(ctx, clinic, [
    {
      eventType: 'SUBSCRIPTION_CANCELED',
      previousStatus: 'ACTIVE',
      newStatus: 'CANCELED',
      reason: 'Cierre temporal por remodelación.',
      triggeredByUserId: ctx.platformAdminId,
      createdAt: clock.days(-100),
    },
    {
      eventType: 'SUBSCRIPTION_REACTIVATED',
      previousStatus: 'CANCELED',
      newStatus: 'ACTIVE',
      triggeredByUserId: ctx.platformAdminId,
      createdAt: clock.days(-70),
    },
    {
      eventType: 'SEATS_DECREASED',
      previousPlan: 'CLINIC_BASIC',
      newPlan: 'CLINIC_BASIC',
      reason: 'Se retiró el cupo adicional contratado.',
      metadata: { source: 'PLATFORM_PANEL', seatsPsychologistsMax: 3 },
      triggeredByUserId: ctx.platformAdminId,
      createdAt: clock.days(-60),
    },
    {
      eventType: 'PAYMENT_FAILED',
      reason: 'El comprobante no corresponde al monto solicitado.',
      metadata: { kind: 'PLAN_UPGRADE', amount: 93.33 },
      triggeredByUserId: ctx.platformAdminId,
      createdAt: clock.days(-24),
    },
    {
      eventType: 'LIMIT_REACHED',
      previousPlan: 'CLINIC_BASIC',
      newPlan: 'CLINIC_BASIC',
      reason: 'Se alcanzó el límite de profesionales activos del plan.',
      metadata: { limit: 'seatsPsychologistsMax', used: 3, max: 3 },
      createdAt: clock.days(-2),
    },
  ]);
  return clinic;
}

/** A downgrade waiting for the end of the period, with the renewal issued at the lower price. */
async function seedScheduledDowngrade(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const periodEnd = clock.days(5);
  const clinic = await createTenant(ctx, {
    name: 'Clínica Bienestar Sur',
    email: 'contacto@bienestarsur.test',
    tenantType: 'CLINIC',
    fiscal: {
      legalName: 'Bienestar Sur S.A.S.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1793456789001',
    },
    planType: 'CLINIC_PRO',
    status: 'ACTIVE',
    subscription: {
      startDate: clock.days(-205),
      currentPeriodStart: clock.days(-25),
      currentPeriodEnd: periodEnd,
      scheduledPlanChange: 'CLINIC_BASIC',
      scheduledPlanChangeAt: periodEnd,
    },
    specialties: ['psychology', 'nutrition'],
    master: {
      email: 'titular.bienestar@psic.com',
      firstName: 'Mónica',
      lastName: 'Zurita',
      note: 'Degradación a Clínica Básica programada para el fin del período (en 5 días)',
    },
  });
  const psychologist = await createUser(ctx, clinic, {
    email: 'psic.bienestar@psic.com',
    firstName: 'Julián',
    lastName: 'Acosta',
    role: 'PROFESIONAL',
    note: 'Profesional activo (psicología)',
    profile: { specialty: 'psychology', title: 'Psicólogo clínico', licenseNumber: 'PSY-EC-030' },
  });
  const nutritionist = await createUser(ctx, clinic, {
    email: 'nutri.bienestar@psic.com',
    firstName: 'Daniela',
    lastName: 'Freire',
    role: 'PROFESIONAL',
    note: 'Profesional activa (nutrición)',
    profile: { specialty: 'nutrition', title: 'Nutricionista', licenseNumber: 'NUT-EC-031' },
  });
  await seedCaseload(ctx, clinic, psychologist, 2, 5);
  await seedCaseload(ctx, clinic, nutritionist, 2, 6);

  await payments(ctx, clinic, [
    {
      kind: 'RENEWAL',
      status: 'PENDING',
      amount: planSubscriptionData('CLINIC_BASIC', 2).basePrice,
      targetPlan: 'CLINIC_BASIC',
      periodStart: periodEnd,
      periodEnd: clock.days(35),
      createdAt: clock.days(-2),
    },
  ]);
  await events(ctx, clinic, [
    {
      eventType: 'PLAN_DOWNGRADED',
      previousPlan: 'CLINIC_PRO',
      newPlan: 'CLINIC_BASIC',
      metadata: { effectiveDate: periodEnd.toISOString(), warnings: [] },
      triggeredByUserId: clinic.master.id,
      createdAt: clock.days(-8),
    },
  ]);
  return clinic;
}

/** The custom plan: no price, no period to renew, double booking. */
async function seedEnterprise(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const clinic = await createTenant(ctx, {
    name: 'Hospital de Día Santa Lucía',
    email: 'contacto@santalucia.test',
    phone: '+593999400001',
    address: 'Av. 6 de Diciembre 1500, Quito',
    tenantType: 'CLINIC',
    fiscal: {
      legalName: 'Hospital de Día Santa Lucía S.A.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1794567890001',
    },
    settings: {
      workingHoursStart: '07:00',
      workingHoursEnd: '20:00',
      workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
      defaultAppointmentDuration: 45,
      allowDoubleBooking: true,
      reminderRules: ['24h', '2h', '30m'],
    },
    planType: 'CLINIC_ENTERPRISE',
    status: 'ACTIVE',
    subscription: {
      startDate: clock.days(-300),
      currentPeriodStart: clock.days(-300),
      currentPeriodEnd: null,
    },
    specialties: ['psychology', 'nutrition', 'physiotherapy', 'dentistry'],
    master: {
      email: 'titular.santalucia@psic.com',
      firstName: 'Fabián',
      lastName: 'Calderón',
      note: 'Plan personalizado sin vencimiento; permite citas simultáneas y abre los sábados',
    },
  });
  const psychologist = await createUser(ctx, clinic, {
    email: 'psic.santalucia@psic.com',
    firstName: 'Rebeca',
    lastName: 'Narváez',
    role: 'PROFESIONAL',
    note: 'Profesional activa con dos citas a la misma hora',
    profile: { specialty: 'psychology', title: 'Psicóloga clínica', licenseNumber: 'PSY-EC-040' },
  });
  const dentist = await createUser(ctx, clinic, {
    email: 'odonto.santalucia@psic.com',
    firstName: 'Marcelo',
    lastName: 'Vinueza',
    role: 'PROFESIONAL',
    note: 'Profesional activo (odontología)',
    profile: { specialty: 'dentistry', title: 'Odontólogo', licenseNumber: 'ODO-EC-041' },
  });
  await seedCaseload(ctx, clinic, dentist, 2, 7);

  // Two patients at the same time with one professional, which this clinic allows.
  const sharedSlot = clinic.agenda.book(psychologist.id, 1, '09:00', 45);
  for (const [firstName, lastName] of [
    ['Olivia', 'Granda'],
    ['Pedro', 'Solano'],
  ]) {
    const patient = await createPatient(
      ctx,
      clinic,
      { firstName, lastName, phone: '+593999400010' },
      { current: [psychologist] },
    );
    await createAppointment(ctx, clinic, {
      patient,
      professional: psychologist,
      slot: sharedSlot,
      status: 'CONFIRMED',
      title: 'Taller grupal de manejo del estrés',
      data: { location: 'Sala de grupos' },
    });
  }

  await events(ctx, clinic, [
    {
      eventType: 'SUBSCRIPTION_ACTIVATED',
      newPlan: 'CLINIC_ENTERPRISE',
      newStatus: 'ACTIVE',
      triggeredByUserId: ctx.platformAdminId,
      createdAt: clock.days(-300),
    },
  ]);
  return clinic;
}

/** The trial ended three days ago and nobody paid: read-only until the grace period runs out. */
async function seedExpiredTrial(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const clinic = await createTenant(ctx, {
    name: 'Consultorio Raíces',
    email: 'contacto@consultorioraices.test',
    tenantType: 'CLINIC',
    planType: 'TRIAL',
    status: 'PAST_DUE',
    subscription: {
      startDate: clock.days(-17),
      trialEndsAt: clock.days(-3),
      currentPeriodStart: clock.days(-17),
      currentPeriodEnd: null,
      // What the platform grants a clinic on trial.
      seatsPsychologistsMax: 3,
      maxActivePatients: 20,
    },
    specialties: ['psychology'],
    master: {
      email: 'titular.raices@psic.com',
      firstName: 'Gloria',
      lastName: 'Enríquez',
      note: 'Prueba vencida hace 3 días: solo lectura (PAST_DUE)',
    },
  });
  const psychologist = await createUser(ctx, clinic, {
    email: 'psic.raices@psic.com',
    firstName: 'Simón',
    lastName: 'Carvajal',
    role: 'PROFESIONAL',
    note: 'Profesional de un consultorio en solo lectura',
    profile: { specialty: 'psychology', title: 'Psicólogo clínico' },
  });
  await seedCaseload(ctx, clinic, psychologist, 2, 8);
  await events(ctx, clinic, [
    {
      eventType: 'TRIAL_STARTED',
      newPlan: 'TRIAL',
      newStatus: 'TRIALING',
      createdAt: clock.days(-17),
    },
    {
      eventType: 'TRIAL_ENDED',
      previousStatus: 'TRIALING',
      newStatus: 'PAST_DUE',
      createdAt: clock.days(-3),
    },
  ]);
  return clinic;
}

/** A paid period ended two days ago with its renewal still unpaid: read-only. */
async function seedPastDue(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const periodEnd = clock.days(-2);
  const clinic = await createTenant(ctx, {
    name: 'Fisioterapia Tapia',
    email: 'contacto@fisioterapiatapia.test',
    tenantType: 'PERSONAL',
    fiscal: {
      legalName: 'Bruno Tapia Robles',
      taxIdentificationType: 'CEDULA',
      taxIdentificationNumber: '1720045176',
    },
    planType: 'PERSONAL_BASIC',
    status: 'PAST_DUE',
    subscription: {
      startDate: clock.days(-92),
      currentPeriodStart: clock.days(-32),
      currentPeriodEnd: periodEnd,
    },
    specialties: ['physiotherapy'],
    master: {
      email: 'titular.fisio@psic.com',
      firstName: 'Bruno',
      lastName: 'Tapia',
      note: 'Renovación sin pagar hace 2 días: solo lectura (PAST_DUE)',
      profile: { specialty: 'physiotherapy', title: 'Fisioterapeuta', licenseNumber: 'FIS-EC-050' },
    },
  });
  await seedCaseload(ctx, clinic, clinic.master, 2, 9);
  await payments(ctx, clinic, [
    {
      kind: 'RENEWAL',
      status: 'PENDING',
      amount: Number(clinic.subscription.basePrice),
      targetPlan: 'PERSONAL_BASIC',
      periodStart: periodEnd,
      periodEnd: clock.days(28),
      createdAt: clock.days(-9),
    },
  ]);
  await events(ctx, clinic, [
    {
      eventType: 'GRACE_PERIOD_ENTERED',
      previousStatus: 'ACTIVE',
      newStatus: 'PAST_DUE',
      createdAt: periodEnd,
    },
  ]);
  return clinic;
}

/** The grace period ran out: every route except the subscription ones is blocked. */
async function seedUnpaid(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const periodEnd = clock.days(-12);
  const clinic = await createTenant(ctx, {
    name: 'Centro Dental Sonrisa',
    email: 'contacto@dentalsonrisa.test',
    tenantType: 'CLINIC',
    fiscal: {
      legalName: 'Dental Sonrisa Cía. Ltda.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1795678901001',
    },
    planType: 'CLINIC_BASIC',
    status: 'UNPAID',
    subscription: {
      startDate: clock.days(-162),
      currentPeriodStart: clock.days(-42),
      currentPeriodEnd: periodEnd,
    },
    specialties: ['dentistry'],
    master: {
      email: 'titular.sonrisa@psic.com',
      firstName: 'Verónica',
      lastName: 'Albán',
      note: 'Período de gracia agotado: acceso bloqueado (UNPAID), solo puede ver su suscripción',
    },
  });
  const dentist = await createUser(ctx, clinic, {
    email: 'odonto.sonrisa@psic.com',
    firstName: 'Álvaro',
    lastName: 'Guerra',
    role: 'PROFESIONAL',
    note: 'Profesional de un consultorio bloqueado por falta de pago',
    profile: { specialty: 'dentistry', title: 'Odontólogo' },
  });
  await seedCaseload(ctx, clinic, dentist, 2, 10);
  await payments(ctx, clinic, [
    {
      kind: 'RENEWAL',
      status: 'PENDING',
      amount: Number(clinic.subscription.basePrice),
      targetPlan: 'CLINIC_BASIC',
      periodStart: periodEnd,
      periodEnd: clock.days(18),
      createdAt: clock.days(-19),
    },
  ]);
  await events(ctx, clinic, [
    {
      eventType: 'GRACE_PERIOD_ENTERED',
      previousStatus: 'ACTIVE',
      newStatus: 'PAST_DUE',
      createdAt: periodEnd,
    },
    {
      eventType: 'GRACE_PERIOD_ENDED',
      previousStatus: 'PAST_DUE',
      newStatus: 'UNPAID',
      createdAt: clock.days(-5),
    },
  ]);
  return clinic;
}

async function seedCanceled(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const clinic = await createTenant(ctx, {
    name: 'Psicología Familiar Ibarra',
    email: 'contacto@psicologiaibarra.test',
    tenantType: 'PERSONAL',
    planType: 'PERSONAL_PRO',
    status: 'CANCELED',
    subscription: {
      startDate: clock.days(-126),
      currentPeriodStart: clock.days(-36),
      currentPeriodEnd: clock.days(-6),
      canceledAt: clock.days(-6),
      endDate: clock.days(-6),
    },
    specialties: ['psychology'],
    master: {
      email: 'titular.familiar@psic.com',
      firstName: 'Lorena',
      lastName: 'Ibarra',
      note: 'Suscripción cancelada: acceso bloqueado (CANCELED)',
      profile: {
        specialty: 'psychology',
        title: 'Terapeuta familiar',
        licenseNumber: 'PSY-EC-060',
      },
    },
  });
  await seedCaseload(ctx, clinic, clinic.master, 1, 11);
  await events(ctx, clinic, [
    {
      eventType: 'SUBSCRIPTION_CANCELED',
      previousStatus: 'ACTIVE',
      newStatus: 'CANCELED',
      reason: 'Cierre del consultorio solicitado por la titular.',
      triggeredByUserId: ctx.platformAdminId,
      createdAt: clock.days(-6),
    },
  ]);
  return clinic;
}

/** Signed up for a paid plan whose first payment never arrived; no fiscal data either. */
async function seedIncomplete(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  return createTenant(ctx, {
    name: 'Clínica Nueva Era',
    email: 'contacto@clinicanuevaera.test',
    tenantType: 'CLINIC',
    planType: 'CLINIC_BASIC',
    status: 'INCOMPLETE',
    subscription: {
      startDate: clock.days(-1),
      currentPeriodStart: clock.days(-1),
      currentPeriodEnd: null,
    },
    specialties: ['psychology', 'nutrition'],
    master: {
      email: 'titular.nuevaera@psic.com',
      firstName: 'Héctor',
      lastName: 'Maldonado',
      note: 'Alta sin pago inicial: acceso bloqueado (INCOMPLETE)',
    },
  });
}

/** Exactly what the platform panel leaves behind: a temporary password and no data at all. */
async function seedJustCreated(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  return createTenant(ctx, {
    name: 'Centro Psicológico Horizonte',
    email: 'contacto@centrohorizonte.test',
    tenantType: 'CLINIC',
    planType: 'TRIAL',
    status: 'TRIALING',
    subscription: {
      startDate: clock.now,
      trialEndsAt: clock.days(14),
      currentPeriodStart: clock.now,
      currentPeriodEnd: null,
      seatsPsychologistsMax: 3,
      maxActivePatients: 20,
    },
    specialties: ['psychology'],
    master: {
      email: 'titular.horizonte@psic.com',
      firstName: 'Camilo',
      lastName: 'Rendón',
      note: 'Recién creado desde /platform: debe cambiar la contraseña; todas las pantallas vacías',
      data: { mustChangePassword: true, activatedAt: clock.now },
    },
  });
}

/** Suspended by the platform: the subscription is fine, but nobody of this clinic can log in. */
async function seedSuspended(ctx: SeedContext): Promise<SeedTenant> {
  const { clock } = ctx;
  const clinic = await createTenant(ctx, {
    name: 'Clínica San Rafael',
    email: 'contacto@clinicasanrafael.test',
    tenantType: 'CLINIC',
    isActive: false,
    fiscal: {
      legalName: 'Clínica San Rafael S.A.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1796789012001',
    },
    planType: 'CLINIC_BASIC',
    status: 'ACTIVE',
    specialties: ['psychology', 'physiotherapy'],
    master: {
      email: 'titular.sanrafael@psic.com',
      firstName: 'Armando',
      lastName: 'Sevilla',
      note: 'Consultorio suspendido por la plataforma: el inicio de sesión responde 401',
    },
  });
  const psychologist = await createUser(ctx, clinic, {
    email: 'psic.sanrafael@psic.com',
    firstName: 'Pilar',
    lastName: 'Ochoa',
    role: 'PROFESIONAL',
    note: 'Profesional de un consultorio suspendido: no puede iniciar sesión',
    profile: { specialty: 'psychology', title: 'Psicóloga clínica' },
  });
  await seedCaseload(ctx, clinic, psychologist, 2, 0);
  await writeAudit(ctx, clinic, {
    actor: { id: ctx.platformAdminId },
    action: 'UPDATE',
    entity: 'TENANT',
    entityId: clinic.tenant.id,
    before: { isActive: true },
    after: { isActive: false },
    reason: 'Suspensión solicitada por el titular mientras dura una auditoría interna.',
    at: clock.days(-4),
  });
  return clinic;
}

/** One clinic per plan and per subscription state, so every access rule has a login to try. */
export async function seedTenantStates(ctx: SeedContext): Promise<SeedTenant[]> {
  const clinics: SeedTenant[] = [];
  for (const seedState of [
    seedPersonalTrial,
    seedPersonalBasic,
    seedPersonalPro,
    seedClinicAtLimits,
    seedScheduledDowngrade,
    seedEnterprise,
    seedExpiredTrial,
    seedPastDue,
    seedUnpaid,
    seedCanceled,
    seedIncomplete,
    seedJustCreated,
    seedSuspended,
  ]) {
    const clinic = await seedState(ctx);
    await syncUsage(ctx, clinic);
    clinics.push(clinic);
  }
  return clinics;
}
