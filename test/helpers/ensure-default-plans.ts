import { PrismaClient } from '@prisma/client';
import { DEFAULT_PLANS, defaultPlanRow } from '../../src/plans/default-plans';

/**
 * Puts back the plans the migrations create, with the same ids, when a test before this one
 * emptied the database (the seed's reset deletes them). Plans already there are left alone.
 */
export async function ensureDefaultPlans(prisma: Pick<PrismaClient, 'plan' | 'planModule'>) {
  for (const plan of DEFAULT_PLANS) {
    const row = defaultPlanRow(plan);
    await prisma.plan.upsert({ where: { id: row.id }, update: {}, create: row });
    await prisma.planModule.createMany({
      data: plan.modules.map((moduleKey) => ({ planId: row.id, moduleKey })),
      skipDuplicates: true,
    });
  }
}
