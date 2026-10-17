import type { ClinicalCipher } from '../src/clinical-access/clinical-cipher';
import type { FileStorage } from '../src/patient-files/file-storage';
import type {
  Appointment,
  AppointmentStatus,
  AuditAction,
  AuditEntity,
  BillingProfile,
  BillingProfileKind,
  Patient,
  PlanType,
  Prisma,
  PrismaClient,
  SubscriptionStatus,
  Tenant,
  TenantSubscription,
  TenantType,
  User,
  UserRole,
} from '@prisma/client';
import { defaultSections, SECTION_KEYS, SectionKey } from '../src/common/sections/section-catalog';
import type { ModuleName } from '../src/subscription/dto/customize-features.dto';
import {
  calculateSubscriptionPrice,
  getPlanFeatureFlags,
  getPlanIncludedModules,
  getPlanLimits,
  moduleToDbKey,
} from '../src/subscription/subscription-pricing';
import { normalizeIdNumber, SriIdType } from '../src/billing-profiles/tax-identification';
import { MAIN_BRANCH_NAME } from '../src/branches/branches.service';
import { specialtyModuleKeys } from '../src/clinical-modules/clinical-module-registry';
import type { DemoSpecialtyKey } from './demo-specialty-scenarios';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The demo clinics work in America/Guayaquil, which has no daylight saving time.
const LOCAL_UTC_OFFSET_HOURS = -5;

export type SpecialtyCatalog = Record<DemoSpecialtyKey, { id: string }>;

/** The modules each specialty owns: the ones the clinical module registry defines for it. */
export const SPECIALTY_MODULE_KEYS: Record<DemoSpecialtyKey, string[]> = {
  psychology: specialtyModuleKeys('PSYCHOLOGY'),
  nutrition: specialtyModuleKeys('NUTRITION'),
  physiotherapy: specialtyModuleKeys('PHYSIOTHERAPY'),
  dentistry: specialtyModuleKeys('DENTISTRY'),
};

/** Every date of the seed is relative to one instant, so a run is consistent with itself. */
export class SeedClock {
  constructor(readonly now: Date) {}

  days(amount: number): Date {
    return new Date(this.now.getTime() + amount * DAY_MS);
  }

  hours(amount: number): Date {
    return new Date(this.now.getTime() + amount * HOUR_MS);
  }

  minutes(amount: number): Date {
    return new Date(this.now.getTime() + amount * MINUTE_MS);
  }

  /** `time` ("HH:mm", clinic local time) on the calendar day `dayOffset` days from today. */
  at(dayOffset: number, time: string): Date {
    const local = new Date(this.now.getTime() + LOCAL_UTC_OFFSET_HOURS * HOUR_MS);
    const [hours, minutes] = time.split(':').map(Number);
    return new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate() + dayOffset,
        hours - LOCAL_UTC_OFFSET_HOURS,
        minutes,
      ),
    );
  }

  /** First instant of the current month, as the billing service computes its monthly quota. */
  monthStart(): Date {
    const start = new Date(this.now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return start;
  }
}

export interface Slot {
  startTime: Date;
  endTime: Date;
  duration: number;
}

const isWeekend = (time: number) =>
  [0, 6].includes(new Date(time + LOCAL_UTC_OFFSET_HOURS * HOUR_MS).getUTCDay());

/** Hands out appointment slots so that no professional ends up with two at the same time. */
export class Agenda {
  private readonly taken = new Map<string, Array<{ start: number; end: number }>>();

  constructor(private readonly clock: SeedClock) {}

  /** Registers an exact time range. Use it before `book` for appointments tied to "now". */
  reserve(professionalId: string, startTime: Date, duration: number): Slot {
    const endTime = new Date(startTime.getTime() + duration * MINUTE_MS);
    const slots = this.taken.get(professionalId) ?? [];
    slots.push({ start: startTime.getTime(), end: endTime.getTime() });
    this.taken.set(professionalId, slots);
    return { startTime, endTime, duration };
  }

  /** A slot at `time` on the working day nearest to `dayOffset`, after anything already booked. */
  book(professionalId: string, dayOffset: number, time: string, duration = 60): Slot {
    let start = this.clock.at(dayOffset, time).getTime();
    const awayFromToday = Math.sign(dayOffset) * DAY_MS;
    while (awayFromToday !== 0 && isWeekend(start)) start += awayFromToday;

    const length = duration * MINUTE_MS;
    const slots = this.taken.get(professionalId) ?? [];
    for (let moved = true; moved; ) {
      moved = false;
      for (const slot of slots) {
        if (start < slot.end && slot.start < start + length) {
          start = slot.end;
          moved = true;
        }
      }
    }
    return this.reserve(professionalId, new Date(start), duration);
  }
}

export interface SeedLogin {
  tenant: string;
  email: string;
  role: UserRole;
  /** What this account is for; shown next to the credentials when the seed finishes. */
  note: string;
}

export interface SeedContext {
  db: PrismaClient;
  clock: SeedClock;
  catalog: SpecialtyCatalog;
  hashedPassword: string;
  platformAdminId: string;
  logins: SeedLogin[];
  /** Things worth trying that are not a login; printed when the seed finishes. */
  highlights: string[];
  /** Encrypts the bytes of the seeded files as the API does. Absent: stored as they are. */
  cipher?: ClinicalCipher;
  /** Where the bytes of clinical files go. Absent: no patient file is seeded. */
  storage?: Pick<FileStorage, 'put'>;
  /** A payment reference that no other seeded payment uses. */
  nextPaymentReference(): string;
}

export interface SeedTenant {
  tenant: Tenant;
  subscription: TenantSubscription;
  master: User;
  agenda: Agenda;
  /** Specialty of each account with a professional profile, by user id. */
  specialtyOf: Map<string, string>;
  /** Counters the API keeps on the subscription; written back by `syncUsage`. */
  usage: { seats: number; patients: number; invoicesThisMonth: number };
}

export interface SeedUserSpec {
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  phone?: string;
  note: string;
  /** Clinical capability. An active profile takes a seat even while the account is inactive. */
  profile?: {
    specialty: DemoSpecialtyKey;
    title: string;
    licenseNumber?: string;
    bio?: string;
    isActive?: boolean;
  };
  data?: Partial<Prisma.UserUncheckedCreateInput>;
}

export interface SeedTenantSpec {
  name: string;
  email: string;
  phone?: string;
  address?: string;
  tenantType: TenantType;
  isActive?: boolean;
  onboardingCompleted?: boolean;
  /** Omit for a clinic that has not completed its fiscal data and therefore cannot invoice. */
  fiscal?: {
    legalName: string;
    taxIdentificationType: 'RUC' | 'CEDULA' | 'PASSPORT';
    taxIdentificationNumber: string;
  };
  settings?: Partial<Prisma.TenantSettingsUncheckedCreateInput>;
  planType: PlanType;
  status: SubscriptionStatus;
  /** Dates, usage and any limit that differs from the plan catalog. */
  subscription?: Partial<Prisma.TenantSubscriptionUncheckedCreateInput>;
  specialties: DemoSpecialtyKey[];
  /** Paid modules on top of the ones the plan includes. */
  addOns?: ModuleName[];
  disabledSections?: SectionKey[];
  disabledModules?: string[];
  master: Omit<SeedUserSpec, 'role'>;
}

/** Subscription columns for a plan, priced the way the API prices a plan change. */
export function planSubscriptionData(
  planType: PlanType,
  specialtyCount: number,
  addOns: ModuleName[] = [],
) {
  const limits = getPlanLimits(planType);
  const featureFlags = getPlanFeatureFlags(planType);
  for (const module of addOns) featureFlags[moduleToDbKey(module)] = true;
  const pricing = calculateSubscriptionPrice({
    planType,
    selectedModules: [...getPlanIncludedModules(planType), ...addOns],
    specialtyCount,
  });

  return {
    planType,
    basePrice: pricing.totalMonthly,
    pricePerSeat: limits.pricePerSeat,
    seatsPsychologistsMax: limits.seatsIncluded,
    maxActivePatients: limits.maxActivePatients,
    storageGB: limits.storageGB,
    monthlyNotificationsLimit: limits.monthlyNotificationsLimit,
    includedSpecialties: limits.includedSpecialties,
    specialtyPrice: limits.specialtyPrice,
    monthlyElectronicInvoicesLimit: limits.monthlyElectronicInvoicesLimit,
    ...featureFlags,
  };
}

export async function createUser(
  ctx: SeedContext,
  clinic: SeedTenant,
  spec: SeedUserSpec,
): Promise<User> {
  const specialtyId = spec.profile ? ctx.catalog[spec.profile.specialty].id : undefined;
  const profileIsActive = spec.profile?.isActive ?? true;

  const user = await ctx.db.user.create({
    data: {
      tenantId: clinic.tenant.id,
      email: spec.email,
      password: ctx.hashedPassword,
      firstName: spec.firstName,
      lastName: spec.lastName,
      phone: spec.phone,
      role: spec.role,
      isActive: true,
      emailVerified: true,
      activatedAt: ctx.clock.days(-30),
      avatarUrl: `https://api.dicebear.com/8.x/initials/svg?seed=${encodeURIComponent(
        `${spec.firstName} ${spec.lastName}`,
      )}`,
      ...(spec.profile
        ? {
            professionalTitle: spec.profile.title,
            licenseNumber: spec.profile.licenseNumber,
            professionalProfile: {
              create: {
                specialtyId,
                professionalTitle: spec.profile.title,
                licenseNumber: spec.profile.licenseNumber,
                bio: spec.profile.bio,
                isActive: profileIsActive,
              },
            },
            professionalSpecialties: { create: { specialtyId, isPrimary: true } },
          }
        : {}),
      ...spec.data,
    },
  });

  if (specialtyId) {
    clinic.specialtyOf.set(user.id, specialtyId);
    if (profileIsActive) clinic.usage.seats += 1;
  }
  ctx.logins.push({
    tenant: clinic.tenant.name,
    email: spec.email,
    role: spec.role,
    note: spec.note,
  });
  return user;
}

/** Tenant, settings, subscription, specialties, modules, sections and the MASTER account. */
export async function createTenant(ctx: SeedContext, spec: SeedTenantSpec): Promise<SeedTenant> {
  const { db, clock } = ctx;
  const tenant = await db.tenant.create({
    data: {
      name: spec.name,
      email: spec.email,
      phone: spec.phone,
      address: spec.address,
      tenantType: spec.tenantType,
      isActive: spec.isActive ?? true,
      onboardingCompleted: spec.onboardingCompleted ?? true,
      ...spec.fiscal,
    },
  });

  await db.tenantSettings.create({
    data: { tenantId: tenant.id, timezone: 'America/Guayaquil', locale: 'es-EC', ...spec.settings },
  });
  // Every clinic has its main branch, as the platform panel creates it.
  await db.branch.create({
    data: {
      tenantId: tenant.id,
      name: MAIN_BRANCH_NAME,
      address: spec.address,
      phone: spec.phone,
      isMain: true,
    },
  });

  const subscription = await db.tenantSubscription.create({
    data: {
      tenantId: tenant.id,
      status: spec.status,
      startDate: clock.days(-30),
      currentPeriodStart: clock.days(-10),
      currentPeriodEnd: clock.days(20),
      ...planSubscriptionData(spec.planType, spec.specialties.length, spec.addOns),
      ...spec.subscription,
    },
  });

  const specialtyIds = spec.specialties.map((key) => ctx.catalog[key].id);
  await db.tenantSpecialty.createMany({
    data: specialtyIds.map((specialtyId) => ({ tenantId: tenant.id, specialtyId })),
  });
  await db.subscriptionSpecialty.createMany({
    data: specialtyIds.map((specialtyId) => ({
      tenantSubscriptionId: subscription.id,
      specialtyId,
    })),
  });

  const enabledSections = new Set<string>(defaultSections(spec.planType, spec.tenantType));
  for (const section of spec.disabledSections ?? []) enabledSections.delete(section);
  await db.tenantModule.createMany({
    data: [
      ...spec.specialties
        .flatMap((key) => SPECIALTY_MODULE_KEYS[key])
        .map((moduleKey) => ({
          tenantId: tenant.id,
          moduleKey,
          enabled: !spec.disabledModules?.includes(moduleKey),
        })),
      ...SECTION_KEYS.map((moduleKey) => ({
        tenantId: tenant.id,
        moduleKey,
        enabled: enabledSections.has(moduleKey),
      })),
    ],
  });

  const clinic: SeedTenant = {
    tenant,
    subscription,
    master: undefined,
    agenda: new Agenda(clock),
    specialtyOf: new Map(),
    usage: { seats: 0, patients: 0, invoicesThisMonth: 0 },
  };
  clinic.master = await createUser(ctx, clinic, { ...spec.master, role: 'MASTER' });
  return clinic;
}

/** Stores on the subscription the counters the API maintains as data is created. */
export async function syncUsage(ctx: SeedContext, clinic: SeedTenant): Promise<void> {
  await ctx.db.tenantSubscription.update({
    where: { tenantId: clinic.tenant.id },
    data: {
      seatsPsychologistsUsed: clinic.usage.seats,
      activePatientsCount: clinic.usage.patients,
      monthlyElectronicInvoicesUsed: clinic.usage.invoicesThisMonth,
    },
  });
}

export async function createPatient(
  ctx: SeedContext,
  clinic: SeedTenant,
  data: Omit<Prisma.PatientUncheckedCreateInput, 'tenantId'>,
  team: { current?: User[]; former?: User[] } = {},
): Promise<Patient> {
  const current = team.current ?? [];
  const patient = await ctx.db.patient.create({
    data: { tenantId: clinic.tenant.id, assignedPsychologistId: current[0]?.id, ...data },
  });

  const members = [
    ...current.map((professional) => ({ professional, isActive: true })),
    ...(team.former ?? []).map((professional) => ({ professional, isActive: false })),
  ];
  if (members.length > 0) {
    await ctx.db.patientProfessional.createMany({
      data: members.map(({ professional, isActive }) => ({
        tenantId: clinic.tenant.id,
        patientId: patient.id,
        professionalId: professional.id,
        assignedById: clinic.master.id,
        assignedAt: data.createdAt ?? ctx.clock.days(-30),
        isActive,
      })),
    });
  }

  if (data.isActive !== false && !data.deletedAt) clinic.usage.patients += 1;
  return patient;
}

/**
 * A billing profile linked to the patient as its default one. The identification is stored
 * normalized, the way the billing profiles service stores it.
 */
export async function createBillingProfile(
  ctx: SeedContext,
  clinic: SeedTenant,
  patient: Patient,
  input: {
    kind: BillingProfileKind;
    idType: SriIdType;
    idNumber: string;
    legalName: string;
    email?: string;
    address?: string;
  },
): Promise<BillingProfile> {
  const profile = await ctx.db.billingProfile.create({
    data: {
      tenantId: clinic.tenant.id,
      kind: input.kind,
      idType: input.idType,
      idNumber: normalizeIdNumber(input.idType, input.idNumber),
      legalName: input.legalName,
      email: input.email,
      address: input.address,
      createdById: clinic.master.id,
    },
  });
  await ctx.db.patientBillingProfile.create({
    data: {
      tenantId: clinic.tenant.id,
      patientId: patient.id,
      billingProfileId: profile.id,
      isDefault: true,
    },
  });
  return profile;
}

export async function createAppointment(
  ctx: SeedContext,
  clinic: SeedTenant,
  input: {
    patient: Patient;
    professional: User;
    slot: Slot;
    status: AppointmentStatus;
    title: string;
    data?: Partial<Prisma.AppointmentUncheckedCreateInput>;
  },
): Promise<Appointment> {
  const { patient, professional, slot, status } = input;
  // The reminder job has already gone over anything that started before the seed ran.
  const reminded = slot.startTime < ctx.clock.now && status !== 'CANCELLED';

  return ctx.db.appointment.create({
    data: {
      tenantId: clinic.tenant.id,
      patientId: patient.id,
      psychologistId: professional.id,
      professionalId: professional.id,
      specialtyId: clinic.specialtyOf.get(professional.id),
      title: input.title,
      ...slot,
      status,
      location: 'Consultorio 1',
      ...(reminded
        ? {
            reminderSent24h: true,
            reminderSent2h: true,
            lastReminderSentAt: new Date(slot.startTime.getTime() - 2 * HOUR_MS),
          }
        : {}),
      ...input.data,
    },
  });
}

const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** One audit row shaped like the ones the API writes: `{ before, after }` snapshots or none. */
export async function writeAudit(
  ctx: SeedContext,
  clinic: SeedTenant,
  entry: {
    actor: User | { id: string };
    action: AuditAction;
    entity: AuditEntity;
    entityId: string;
    patientId?: string;
    before?: unknown;
    after?: unknown;
    reason?: string;
    at?: Date;
  },
): Promise<void> {
  const hasSnapshot = entry.before !== undefined || entry.after !== undefined;
  await ctx.db.auditLog.create({
    data: {
      tenantId: clinic.tenant.id,
      userId: entry.actor.id,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId,
      patientId: entry.patientId,
      reason: entry.reason,
      changes: hasSnapshot
        ? toJson({ before: entry.before ?? null, after: entry.after ?? null })
        : undefined,
      ipAddress: '190.15.128.10',
      userAgent: 'Mozilla/5.0 (demo seed)',
      createdAt: entry.at ?? ctx.clock.now,
    },
  });
}
