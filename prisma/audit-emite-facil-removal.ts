import { PrismaClient } from '@prisma/client';

/**
 * Read-only preview of the migration that drops the former external invoicing provider
 * (20261102000100). Run it against the target database before deploying: it prints counts and
 * tenant ids only, never document content, and runs in a READ ONLY transaction. It uses raw SQL
 * because the generated client no longer has the provider's tables and columns.
 */
export type ProviderRemovalAudit =
  | { alreadyApplied: true }
  | {
      alreadyApplied: false;
      /** Former-provider requests by connection environment, status and reconciliation flag. */
      requestsByEnvironmentAndStatus: {
        environment: string | null;
        status: string;
        requiresReconciliation: boolean;
        count: number;
      }[];
      /** Requests that make the migration abort: authorized or pending in environment '2'. */
      productionBlocking: number;
      ordersToPaid: number;
      sessionsToBillingFailed: number;
      /** SRI requests that replaced a former-provider one and will start their own chain. */
      sriChainsRestarted: number;
      /** What will be deleted, per tenant. */
      deletedPerTenant: {
        tenantId: string;
        connections: number;
        refs: number;
        points: number;
        requests: number;
        events: number;
      }[];
    };

const OLD_ONLY_INVOICED_ORDER = `
  o."status" = 'INVOICED'
  AND EXISTS (SELECT 1 FROM "InvoiceRequest" r WHERE r."orderId" = o."id" AND r."issuerId" IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "InvoiceRequest" r
    WHERE r."orderId" = o."id"
      AND r."issuerId" IS NOT NULL
      AND r."status" IN ('REQUESTED', 'PROCESSING', 'AUTHORIZED')
  )`;

type Raw = { $queryRawUnsafe<T = unknown>(query: string): Promise<T> };

async function count(tx: Raw, sql: string): Promise<number> {
  const [row] = await tx.$queryRawUnsafe<{ count: number }[]>(sql);
  return row.count;
}

export async function auditFormerProviderRemoval(
  client: PrismaClient,
): Promise<ProviderRemovalAudit> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const [{ present }] = await tx.$queryRawUnsafe<{ present: boolean }[]>(
      `SELECT to_regclass('"InvoicingConnection"') IS NOT NULL AS present`,
    );
    if (!present) return { alreadyApplied: true as const };

    const requestsByEnvironmentAndStatus = await tx.$queryRawUnsafe<
      {
        environment: string | null;
        status: string;
        requiresReconciliation: boolean;
        count: number;
      }[]
    >(
      `SELECT c."environment", r."status"::text AS "status", r."requiresReconciliation",
              count(*)::int AS "count"
       FROM "InvoiceRequest" r
       LEFT JOIN "InvoicingConnection" c ON c."id" = r."connectionId"
       WHERE r."issuerId" IS NULL
       GROUP BY 1, 2, 3
       ORDER BY 1, 2, 3`,
    );
    const productionBlocking = await count(
      tx,
      `SELECT count(*)::int AS "count"
       FROM "InvoiceRequest" r
       JOIN "InvoicingConnection" c ON c."id" = r."connectionId"
       WHERE r."issuerId" IS NULL
         AND c."environment" = '2'
         AND (r."status" IN ('AUTHORIZED', 'PROCESSING') OR r."requiresReconciliation")`,
    );
    const ordersToPaid = await count(
      tx,
      `SELECT count(*)::int AS "count" FROM "Order" o WHERE ${OLD_ONLY_INVOICED_ORDER}`,
    );
    const sessionsToBillingFailed = await count(
      tx,
      `SELECT count(*)::int AS "count"
       FROM "TreatmentSession" s
       WHERE s."status" IN ('BILLING_PENDING', 'BILLED')
         AND EXISTS (
           SELECT 1 FROM "OrderItem" i JOIN "Order" o ON o."id" = i."orderId"
           WHERE i."treatmentSessionId" = s."id" AND i."releasedAt" IS NULL
             AND ${OLD_ONLY_INVOICED_ORDER}
         )`,
    );
    const sriChainsRestarted = await count(
      tx,
      `SELECT count(*)::int AS "count"
       FROM "InvoiceRequest" f
       JOIN "InvoiceRequest" replaced ON replaced."id" = f."replacesInvoiceRequestId"
       WHERE f."issuerId" IS NOT NULL AND replaced."issuerId" IS NULL`,
    );
    const perTenant = await tx.$queryRawUnsafe<
      { tenantId: string; kind: keyof Omit<DeletedRow, 'tenantId'>; count: number }[]
    >(
      `SELECT "tenantId", 'connections' AS "kind", count(*)::int AS "count"
         FROM "InvoicingConnection" GROUP BY 1
       UNION ALL
       SELECT c."tenantId", 'refs', count(*)::int
         FROM "InvoicingRef" f JOIN "InvoicingConnection" c ON c."id" = f."connectionId" GROUP BY 1
       UNION ALL
       SELECT b."tenantId", 'points', count(*)::int
         FROM "BranchEmissionPoint" p JOIN "Branch" b ON b."id" = p."branchId"
         WHERE p."issuerId" IS NULL GROUP BY 1
       UNION ALL
       SELECT "tenantId", 'requests', count(*)::int
         FROM "InvoiceRequest" WHERE "issuerId" IS NULL GROUP BY 1
       UNION ALL
       SELECT COALESCE(r."tenantId", c."tenantId"), 'events', count(*)::int
         FROM "InvoiceRequestEvent" e
         LEFT JOIN "InvoiceRequest" r ON r."id" = e."invoiceRequestId"
         LEFT JOIN "InvoicingConnection" c ON c."id" = e."connectionId"
         WHERE e."issuerId" IS NULL OR (r."id" IS NOT NULL AND r."issuerId" IS NULL)
         GROUP BY 1`,
    );
    const tenants = new Map<string, DeletedRow>();
    for (const row of perTenant) {
      const entry = tenants.get(row.tenantId) ?? {
        tenantId: row.tenantId,
        connections: 0,
        refs: 0,
        points: 0,
        requests: 0,
        events: 0,
      };
      entry[row.kind] += row.count;
      tenants.set(row.tenantId, entry);
    }
    return {
      alreadyApplied: false as const,
      requestsByEnvironmentAndStatus,
      productionBlocking,
      ordersToPaid,
      sessionsToBillingFailed,
      sriChainsRestarted,
      deletedPerTenant: [...tenants.values()].sort((a, b) => a.tenantId.localeCompare(b.tenantId)),
    };
  });
}

type DeletedRow = Extract<
  ProviderRemovalAudit,
  { alreadyApplied: false }
>['deletedPerTenant'][number];

if (require.main === module) {
  const client = new PrismaClient();
  auditFormerProviderRemoval(client)
    .then((audit) => {
      console.log(JSON.stringify(audit, null, 2));
      // The migration would abort: real documents need a manual decision first.
      if ('productionBlocking' in audit && audit.productionBlocking > 0) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => client.$disconnect());
}
