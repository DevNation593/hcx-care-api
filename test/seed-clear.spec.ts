import { Prisma, PrismaClient } from '@prisma/client';
import { clearDatabase } from '../prisma/seed';

// Shared catalog the seed updates in place instead of recreating.
const KEPT = new Set(['specialty']);

const delegateName = (model: string) => `${model.charAt(0).toLowerCase()}${model.slice(1)}`;

/** Which models `clearDatabase` empties, in the order it does it. */
async function clearingOrder(): Promise<string[]> {
  const deleted: string[] = [];
  const special: Record<string, unknown> = {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
    $executeRaw: async () => 0,
  };
  const db: unknown = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        special[model] ?? {
          findMany: async () => [],
          updateMany: async () => ({ count: 0 }),
          deleteMany: async () => {
            if (!deleted.includes(model)) deleted.push(model);
            return { count: 0 };
          },
        },
    },
  );
  await clearDatabase(db as PrismaClient);
  return deleted;
}

describe('clearDatabase', () => {
  let order: string[];
  beforeAll(async () => {
    order = await clearingOrder();
  });

  it('empties every table of the schema, so data the seed never writes cannot block it', () => {
    const missing = Prisma.dmmf.datamodel.models
      .map(({ name }) => delegateName(name))
      .filter((model) => !KEPT.has(model) && !order.includes(model));
    expect(missing).toEqual([]);
  });

  it('deletes each row before the rows it points to without cascade', () => {
    const blocking: string[] = [];
    for (const model of Prisma.dmmf.datamodel.models) {
      for (const field of model.fields) {
        if (!field.relationFromFields?.length || field.type === model.name) continue;
        // Prisma's default: required relations restrict, optional ones are set to null.
        const onDelete = field.relationOnDelete ?? (field.isRequired ? 'Restrict' : 'SetNull');
        if (onDelete !== 'Restrict' && onDelete !== 'NoAction') continue;
        const child = delegateName(model.name);
        const parent = delegateName(field.type);
        if (KEPT.has(parent)) continue;
        if (order.indexOf(child) > order.indexOf(parent)) {
          blocking.push(`${child}.${field.name} blocks deleting ${parent}`);
        }
      }
    }
    expect(blocking).toEqual([]);
  });
});
