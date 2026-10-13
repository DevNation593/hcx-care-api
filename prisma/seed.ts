import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import { ClinicalCipher, parseClinicalKeys } from '../src/clinical-access/clinical-cipher';
import { FileStorage } from '../src/patient-files/file-storage';
import { createFileStorage } from '../src/patient-files/file-storage.factory';
import { createPlatformAdmin } from './create-platform-admin';
import { encryptClinicalData } from './encrypt-clinical-data';
import {
  importDiagnosisCodes,
  parseDiagnosisCsv,
  STARTER_DIAGNOSIS_CODES,
} from './import-diagnosis-codes';
import {
  SeedClock,
  SeedContext,
  SeedLogin,
  SPECIALTY_MODULE_KEYS,
  SpecialtyCatalog,
} from './seed-helpers';
import { seedClinicalWorkflow } from './seed-clinical-workflow';
import { seedMainClinic } from './seed-main-clinic';
import { seedTenantStates } from './seed-tenant-states';

export const DEMO_PASSWORD = 'Password123!';
const PLATFORM_ADMIN_EMAIL = 'admin@plataforma.test';

async function seedSpecialtyCatalog(db: PrismaClient): Promise<SpecialtyCatalog> {
  const specialties = await Promise.all([
    db.specialty.upsert({
      where: { code: 'PSYCHOLOGY' },
      update: { name: 'Psicología', isActive: true },
      create: {
        code: 'PSYCHOLOGY',
        name: 'Psicología',
        description: 'Atención psicológica y psicoterapia.',
      },
    }),
    db.specialty.upsert({
      where: { code: 'NUTRITION' },
      update: { name: 'Nutrición', isActive: true },
      create: {
        code: 'NUTRITION',
        name: 'Nutrición',
        description: 'Evaluación nutricional y planes alimenticios.',
      },
    }),
    db.specialty.upsert({
      where: { code: 'PHYSIOTHERAPY' },
      update: { name: 'Fisioterapia', isActive: true },
      create: {
        code: 'PHYSIOTHERAPY',
        name: 'Fisioterapia',
        description: 'Evaluación funcional y rehabilitación.',
      },
    }),
    db.specialty.upsert({
      where: { code: 'DENTISTRY' },
      update: { name: 'Odontología', isActive: true },
      create: {
        code: 'DENTISTRY',
        name: 'Odontología',
        description: 'Prevención y atención odontológica.',
      },
    }),
  ]);
  // Retired from the catalog: no plan offers it and no clinic can select it.
  await db.specialty.upsert({
    where: { code: 'SPEECH_THERAPY' },
    update: { isActive: false },
    create: {
      code: 'SPEECH_THERAPY',
      name: 'Terapia de lenguaje',
      description: 'Especialidad retirada del catálogo.',
      isActive: false,
    },
  });

  const [psychology, nutrition, physiotherapy, dentistry] = specialties;
  const catalog: SpecialtyCatalog = { psychology, nutrition, physiotherapy, dentistry };

  await db.specialtyModule.createMany({
    data: Object.entries(SPECIALTY_MODULE_KEYS).flatMap(([key, moduleKeys]) =>
      moduleKeys.map((moduleKey) => ({
        specialtyId: catalog[key as keyof SpecialtyCatalog].id,
        moduleKey,
      })),
    ),
    skipDuplicates: true,
  });

  await db.planSpecialty.createMany({
    data: specialties.flatMap((specialty) => [
      { planType: 'TRIAL', specialtyId: specialty.id },
      { planType: 'PERSONAL_BASIC', specialtyId: specialty.id },
      { planType: 'PERSONAL_PRO', specialtyId: specialty.id },
      { planType: 'CLINIC_BASIC', specialtyId: specialty.id },
      { planType: 'CLINIC_PRO', specialtyId: specialty.id },
      { planType: 'CLINIC_ENTERPRISE', specialtyId: specialty.id },
    ]),
    skipDuplicates: true,
  });

  return catalog;
}

/** Empties every table the seed writes, and the bytes of the clinical files when a storage is given. */
export async function clearDatabase(db: PrismaClient, storage?: SeedStorage) {
  if (storage) {
    // The rows are about to go: their bytes would be left behind with nothing pointing at them.
    const files = await db.patientFile.findMany({ select: { storageKey: true } });
    await Promise.all(files.map(({ storageKey }) => storage.remove(storageKey)));
  }
  // Files restrict deleting their uploader, so they go before the users.
  await db.patientFile.deleteMany();
  await db.documentTemplate.deleteMany();
  await db.professionalBranch.deleteMany();
  await db.specialtyRecord.deleteMany();
  await db.formDefinition.deleteMany();
  await db.encounter.deleteMany();
  await db.medication.deleteMany();
  await db.userPermission.deleteMany();
  await db.diagnosisCode.deleteMany();
  await db.invoice.deleteMany();
  await db.billingSettings.deleteMany();
  await db.tenantModule.deleteMany();
  await db.subscriptionSpecialty.deleteMany();
  await db.planSpecialty.deleteMany();
  await db.specialtyModule.deleteMany();
  await db.professionalSpecialty.deleteMany();
  await db.professionalProfile.deleteMany();
  await db.tenantSpecialty.deleteMany();
  await db.auditLog.deleteMany();
  await db.notificationLog.deleteMany();
  await db.notificationPreference.deleteMany();
  await db.pushSubscription.deleteMany();
  await db.nextSessionPlan.deleteMany();
  await db.task.deleteMany();
  await db.clinicalNote.deleteMany();
  await db.appointment.deleteMany();
  await db.patientProfessional.deleteMany();
  await db.patient.deleteMany();
  await db.refreshToken.deleteMany();
  await db.subscriptionEvent.deleteMany();
  await db.subscriptionPayment.deleteMany();
  await db.usageMetrics.deleteMany();
  await db.user.deleteMany();
  await db.branch.deleteMany();
  await db.tenantSettings.deleteMany();
  await db.tenantSubscription.deleteMany();
  await db.tenant.deleteMany();
}

/** Where the seed keeps the bytes of the clinical files it creates. */
export type SeedStorage = Pick<FileStorage, 'put' | 'remove'>;

export interface SeedResult {
  logins: SeedLogin[];
  /** Things worth trying that are not a login. */
  highlights: string[];
  /** Whether clinical content was stored encrypted (it is when a key is configured). */
  encrypted: boolean;
}

/**
 * Replaces every row with the demo data set: the platform tenant, one clinic with data in
 * every state, one clinic that walks through the clinical workflow (branches, encounters,
 * documents, files) and one clinic per plan and subscription state. All dates hang from `now`.
 * Patient files are seeded only when a `storage` is given for their bytes.
 */
export async function seedDatabase(
  db: PrismaClient,
  options: { now?: Date; cipher?: ClinicalCipher; storage?: SeedStorage } = {},
): Promise<SeedResult> {
  await clearDatabase(db, options.storage);

  const catalog = await seedSpecialtyCatalog(db);
  // A starter set of frequent codes; the official classification is imported separately.
  await importDiagnosisCodes(
    db,
    parseDiagnosisCsv(fs.readFileSync(STARTER_DIAGNOSIS_CODES, 'utf8')),
  );
  const platform = await createPlatformAdmin(db, {
    email: PLATFORM_ADMIN_EMAIL,
    password: DEMO_PASSWORD,
    firstName: 'Admin',
    lastName: 'Plataforma',
  });

  let paymentReferences = 0;
  const ctx: SeedContext = {
    db,
    clock: new SeedClock(options.now ?? new Date()),
    catalog,
    hashedPassword: await bcrypt.hash(DEMO_PASSWORD, 10),
    platformAdminId: platform.userId,
    logins: [
      {
        tenant: 'Plataforma',
        email: PLATFORM_ADMIN_EMAIL,
        role: 'ADMIN',
        note: 'Administrador de la plataforma: solo entra al panel /platform',
      },
    ],
    highlights: [],
    cipher: options.cipher?.enabled ? options.cipher : undefined,
    storage: options.storage,
    nextPaymentReference: () => `TRF-DEMO-${String(++paymentReferences).padStart(4, '0')}`,
  };

  await seedMainClinic(ctx);
  await seedClinicalWorkflow(ctx);
  await seedTenantStates(ctx);

  // The rows above are written as plain text; with a key configured they are stored as the
  // API stores them, so the demo data is readable by the API and nothing else.
  const encrypted = options.cipher?.enabled ?? false;
  if (encrypted) {
    await encryptClinicalData(
      db as unknown as Parameters<typeof encryptClinicalData>[0],
      options.cipher,
    );
  }

  return { logins: ctx.logins, highlights: ctx.highlights, encrypted };
}

function printSummary({ logins, highlights, encrypted }: SeedResult) {
  const emailWidth = Math.max(...logins.map(({ email }) => email.length));
  const roleWidth = Math.max(...logins.map(({ role }) => role.length));

  console.log('✅ Seed completed successfully.');
  console.log(`Clinical content: ${encrypted ? 'encrypted' : 'plain text (no key configured)'}`);
  console.log(`Password for every account: ${DEMO_PASSWORD}`);
  for (const tenant of new Set(logins.map((login) => login.tenant))) {
    console.log('');
    console.log(tenant);
    for (const login of logins.filter((candidate) => candidate.tenant === tenant)) {
      console.log(
        `  ${login.email.padEnd(emailWidth)}  ${login.role.padEnd(roleWidth)}  ${login.note}`,
      );
    }
  }
  if (highlights.length > 0) {
    console.log('');
    for (const highlight of highlights) console.log(highlight);
  }
}

async function main() {
  await import('dotenv/config');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The demo seed deletes every row; it does not run with NODE_ENV=production');
  }

  const prisma = new PrismaClient();
  try {
    console.log('🌱 Starting deterministic demo seed...');
    const result = await seedDatabase(prisma, {
      cipher: new ClinicalCipher(parseClinicalKeys(process.env.CLINICAL_ENCRYPTION_KEYS)),
      // The same place the API reads the clinical files from.
      storage: createFileStorage({
        get: (key: string) => process.env[key],
      } as unknown as ConfigService),
    });
    printSummary(result);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  });
}
