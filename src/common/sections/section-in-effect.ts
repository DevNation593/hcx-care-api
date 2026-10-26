import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SectionKey, isSectionInEffect, sectionDefinition } from './section-catalog';

function sectionWithParent(section: SectionKey): SectionKey[] {
  const { parent } = sectionDefinition(section);
  return parent ? [parent, section] : [section];
}

/**
 * 403 SECTION_NOT_ENABLED unless the section is on for the tenant. Fail closed: a missing row is
 * treated exactly like a disabled section, and a submodule also needs its module's row on.
 */
export async function assertSectionInEffect(
  db: Pick<Prisma.TransactionClient, 'tenantModule'>,
  tenantId: string,
  section: SectionKey,
): Promise<void> {
  const rows = tenantId
    ? await db.tenantModule.findMany({
        where: { tenantId, moduleKey: { in: sectionWithParent(section) }, enabled: true },
        select: { moduleKey: true },
      })
    : [];

  if (!isSectionInEffect(section, new Set(rows.map(({ moduleKey }) => moduleKey)))) {
    throw new ForbiddenException({
      statusCode: 403,
      code: 'SECTION_NOT_ENABLED',
      message: 'Esta sección no está habilitada para tu consultorio.',
      section,
    });
  }
}
