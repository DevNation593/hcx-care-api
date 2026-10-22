import { TenantType } from '@prisma/client';
import { SECTION_KEYS } from '../../src/common/sections/section-catalog';
import { PlatformTenantsService } from '../../src/platform/platform-tenants.service';
import { PrismaService } from '../../src/prisma/prisma.service';

export const TEST_PASSWORD = 'Password123!';

/**
 * Creates a CLINIC tenant on the TRIAL plan through the platform service, with the PSYCHOLOGY
 * specialty (created if missing) and all eight sections enabled. The master login is `admin+<sequence>@tenant.test`
 * and its temporary-password flag is cleared so tests can use it right away.
 */
export async function createTestTenant(
  deps: { tenants: PlatformTenantsService; prisma: PrismaService },
  sequence: number,
) {
  await deps.prisma.specialty.upsert({
    where: { code: 'PSYCHOLOGY' },
    update: { isActive: true },
    create: { code: 'PSYCHOLOGY', name: 'Psicología', isActive: true },
  });
  const detail = await deps.tenants.create(
    {
      name: 'Tenant ' + sequence + ' Clinic',
      email: 'contact+' + sequence + '@tenant.test',
      tenantType: TenantType.CLINIC,
      timezone: 'America/Guayaquil',
      locale: 'es-EC',
      masterFirstName: 'Admin',
      masterLastName: String(sequence),
      masterEmail: 'admin+' + sequence + '@tenant.test',
      temporaryPassword: TEST_PASSWORD,
      planType: 'TRIAL',
      specialtyCodes: ['PSYCHOLOGY'],
      sections: [...SECTION_KEYS],
    },
    'e2e-setup',
  );
  await deps.prisma.user.update({
    where: { id: detail.master!.id },
    data: { mustChangePassword: false },
  });
  return { ...detail, id: detail.tenant.id };
}
