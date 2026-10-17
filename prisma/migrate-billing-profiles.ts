import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  assertValidTaxIdentification,
  normalizeIdNumber,
  type SriIdType,
} from '../src/billing-profiles/tax-identification';

export interface BillingProfilesMigrationSummary {
  profilesCreated: number;
  profilesReused: number;
  linksCreated: number;
  skippedInvalid: { patientId: string; reason: string }[];
  permissionsGranted: number;
}

// Legacy Patient.billingTaxIdType value -> SRI identification type code.
const LEGACY_ID_TYPES: Record<string, SriIdType> = {
  RUC: '04',
  CEDULA: '05',
  PASSPORT: '06',
};

const PROFESSIONAL_BILLING_PERMISSIONS = ['billing.view', 'billing.create'];

/**
 * Turns the legacy billing fields of live patients into billing profiles linked to them, and
 * grants PROFESIONAL users the billing permissions that stopped being role defaults. Safe to run
 * repeatedly: whatever already exists is left as it is.
 */
export async function migrateBillingProfiles(
  prisma: PrismaClient | PrismaService,
): Promise<BillingProfilesMigrationSummary> {
  const summary: BillingProfilesMigrationSummary = {
    profilesCreated: 0,
    profilesReused: 0,
    linksCreated: 0,
    skippedInvalid: [],
    permissionsGranted: 0,
  };

  const tenantIds = new Set<string>();
  const patientTenants = await prisma.patient.findMany({
    where: { deletedAt: null, billingName: { not: null }, billingTaxId: { not: null } },
    select: { tenantId: true },
    distinct: ['tenantId'],
  });
  patientTenants.forEach((row) => tenantIds.add(row.tenantId));
  const professionalTenants = await prisma.user.findMany({
    where: { role: 'PROFESIONAL', isActive: true },
    select: { tenantId: true },
    distinct: ['tenantId'],
  });
  professionalTenants.forEach((row) => tenantIds.add(row.tenantId));

  for (const tenantId of tenantIds) {
    const tenantSummary = await runTenant(prisma, tenantId);
    summary.profilesCreated += tenantSummary.profilesCreated;
    summary.profilesReused += tenantSummary.profilesReused;
    summary.linksCreated += tenantSummary.linksCreated;
    summary.skippedInvalid.push(...tenantSummary.skippedInvalid);
    summary.permissionsGranted += tenantSummary.permissionsGranted;
  }
  return summary;
}

async function runTenant(
  prisma: PrismaClient | PrismaService,
  tenantId: string,
): Promise<BillingProfilesMigrationSummary> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await prisma.$transaction((tx) => migrateTenant(tx, tenantId), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        attempt < 3 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('BILLING_PROFILES_MIGRATION_INCOMPLETE');
}

async function migrateTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<BillingProfilesMigrationSummary> {
  const summary: BillingProfilesMigrationSummary = {
    profilesCreated: 0,
    profilesReused: 0,
    linksCreated: 0,
    skippedInvalid: [],
    permissionsGranted: 0,
  };

  // BillingProfile.createdById is required: the tenant's MASTER user (one per tenant) owns them.
  const master = await tx.user.findFirst({
    where: { tenantId, role: 'MASTER' },
    select: { id: true },
  });

  const patients = await tx.patient.findMany({
    where: { tenantId, deletedAt: null, billingName: { not: null }, billingTaxId: { not: null } },
    orderBy: { createdAt: 'asc' },
  });

  for (const patient of patients) {
    const idType = LEGACY_ID_TYPES[(patient.billingTaxIdType ?? '').trim().toUpperCase()];
    const legalName = (patient.billingName ?? '').trim();
    if (!legalName) continue;
    if (!idType) {
      // A tax id without a known type cannot become a profile: report it so it is fixed by hand.
      if ((patient.billingTaxId ?? '').trim() !== '') {
        summary.skippedInvalid.push({ patientId: patient.id, reason: 'TAX_ID_TYPE_INVALID' });
      }
      continue;
    }

    const email = (patient.billingEmail ?? patient.email ?? '').trim();
    if (!email) {
      summary.skippedInvalid.push({ patientId: patient.id, reason: 'EMAIL_MISSING' });
      continue;
    }

    const idNumber = normalizeIdNumber(idType, patient.billingTaxId ?? '');
    try {
      assertValidTaxIdentification(idType, idNumber, legalName);
    } catch {
      summary.skippedInvalid.push({ patientId: patient.id, reason: 'IDENTIFICATION_INVALID' });
      continue;
    }

    let profile = await tx.billingProfile.findUnique({
      where: { tenantId_idType_idNumber: { tenantId, idType, idNumber } },
    });
    const existingLink = profile
      ? await tx.patientBillingProfile.findUnique({
          where: {
            patientId_billingProfileId: { patientId: patient.id, billingProfileId: profile.id },
          },
        })
      : null;
    if (existingLink) continue;

    if (profile) {
      summary.profilesReused++;
    } else {
      if (!master) {
        summary.skippedInvalid.push({ patientId: patient.id, reason: 'MASTER_MISSING' });
        continue;
      }
      const isCompany = idType === '04' && ['6', '9'].includes(idNumber[2]);
      profile = await tx.billingProfile.create({
        data: {
          tenantId,
          kind: isCompany ? 'COMPANY' : 'PERSON',
          idType,
          idNumber,
          legalName,
          email,
          address: patient.billingAddress,
          createdById: master.id,
        },
      });
      summary.profilesCreated++;
    }

    const hasDefault = await tx.patientBillingProfile.count({
      where: { patientId: patient.id, isDefault: true },
    });
    await tx.patientBillingProfile.create({
      data: {
        tenantId,
        patientId: patient.id,
        billingProfileId: profile.id,
        isDefault: hasDefault === 0,
      },
    });
    summary.linksCreated++;
  }

  const professionals = await tx.user.findMany({
    where: { tenantId, role: 'PROFESIONAL', isActive: true },
    select: { id: true },
  });
  for (const professional of professionals) {
    for (const permission of PROFESSIONAL_BILLING_PERMISSIONS) {
      const existing = await tx.userPermission.findUnique({
        where: { userId_permission: { userId: professional.id, permission } },
      });
      if (existing) continue;
      await tx.userPermission.create({
        data: { tenantId, userId: professional.id, permission, granted: true },
      });
      summary.permissionsGranted++;
    }
  }

  return summary;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  migrateBillingProfiles(prisma)
    .then((summary) => console.log(JSON.stringify(summary)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
