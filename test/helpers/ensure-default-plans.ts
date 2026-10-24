import { PrismaClient } from '@prisma/client';
import { DEFAULT_PLANS } from '../../src/plans/default-plans';

/**
 * Puts back the plans the migration creates, with the same ids, when a test before this one
 * emptied the database (the seed's reset deletes them). Plans already there are left alone.
 */
export async function ensureDefaultPlans(prisma: Pick<PrismaClient, 'plan' | 'planModule'>) {
  for (const { modules, ...plan } of DEFAULT_PLANS) {
    const id = `plan_${plan.code.toLowerCase()}`;
    await prisma.plan.upsert({ where: { id }, update: {}, create: { id, ...plan } });
    await prisma.planModule.createMany({
      data: modules.map((moduleKey) => ({ planId: id, moduleKey })),
      skipDuplicates: true,
    });
  }
}
