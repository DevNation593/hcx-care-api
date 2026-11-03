-- The documents of the former external invoicing provider were test data only (production shares
-- its database with the demos). Requests without "issuerId" are that provider's: they are removed,
-- and an order invoiced only through them becomes billable again, as a failed request leaves it.
-- Requests with an "issuerId" (and orders that have one) are not touched.

-- Sessions first: they are found through the orders still INVOICED.
UPDATE "TreatmentSession" s
SET "status" = 'BILLING_FAILED', "version" = s."version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE s."status" IN ('BILLING_PENDING', 'BILLED')
  AND EXISTS (
    SELECT 1
    FROM "OrderItem" i
    JOIN "Order" o ON o."id" = i."orderId"
    WHERE i."treatmentSessionId" = s."id"
      AND i."releasedAt" IS NULL
      AND o."status" = 'INVOICED'
      AND EXISTS (SELECT 1 FROM "InvoiceRequest" r WHERE r."orderId" = o."id" AND r."issuerId" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "InvoiceRequest" r WHERE r."orderId" = o."id" AND r."issuerId" IS NOT NULL)
  );

UPDATE "Order" o
SET "status" = 'PAID', "version" = o."version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE o."status" = 'INVOICED'
  AND EXISTS (SELECT 1 FROM "InvoiceRequest" r WHERE r."orderId" = o."id" AND r."issuerId" IS NULL)
  AND NOT EXISTS (SELECT 1 FROM "InvoiceRequest" r WHERE r."orderId" = o."id" AND r."issuerId" IS NOT NULL);

-- An SRI request that replaced one of the provider's now starts its own chain.
UPDATE "InvoiceRequest" r
SET "rootRequestId" = f."id"
FROM "InvoiceRequest" f
JOIN "InvoiceRequest" replaced ON replaced."id" = f."replacesInvoiceRequestId"
WHERE replaced."issuerId" IS NULL
  AND f."issuerId" IS NOT NULL
  AND r."issuerId" IS NOT NULL
  AND r."rootRequestId" = f."rootRequestId";

UPDATE "InvoiceRequest"
SET "replacesInvoiceRequestId" = NULL
WHERE "replacesInvoiceRequestId" IN (SELECT "id" FROM "InvoiceRequest" WHERE "issuerId" IS NULL);

DELETE FROM "InvoiceRequestEvent"
WHERE "issuerId" IS NULL
   OR "invoiceRequestId" IN (SELECT "id" FROM "InvoiceRequest" WHERE "issuerId" IS NULL);

DELETE FROM "InvoiceRequest" WHERE "issuerId" IS NULL;

DELETE FROM "BranchEmissionPoint" WHERE "issuerId" IS NULL;

-- DropForeignKey
ALTER TABLE "BranchEmissionPoint" DROP CONSTRAINT "BranchEmissionPoint_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "InvoiceRequest" DROP CONSTRAINT "InvoiceRequest_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "InvoiceRequestEvent" DROP CONSTRAINT "InvoiceRequestEvent_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "InvoicingConnection" DROP CONSTRAINT "InvoicingConnection_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "InvoicingRef" DROP CONSTRAINT "InvoicingRef_connectionId_fkey";

-- DropIndex
DROP INDEX "BranchEmissionPoint_connectionId_idx";

-- DropIndex
DROP INDEX "InvoiceRequest_connectionId_externalDocumentId_key";

-- DropIndex
DROP INDEX "InvoiceRequest_providerIdempotencyKey_key";

-- DropIndex
DROP INDEX "InvoiceRequestEvent_connectionId_webhookEventId_key";

-- AlterTable
ALTER TABLE "BranchEmissionPoint" DROP COLUMN "connectionId",
DROP COLUMN "emissionPointId",
DROP COLUMN "establishmentId",
ALTER COLUMN "establishmentAddress" SET NOT NULL,
ALTER COLUMN "issuerId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceRequest" DROP COLUMN "connectionId",
DROP COLUMN "externalDocumentId",
DROP COLUMN "providerBodyEncrypted",
DROP COLUMN "providerBodyHash",
DROP COLUMN "providerIdempotencyKey",
DROP COLUMN "requiresReconciliation",
ALTER COLUMN "issuerId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceRequestEvent" DROP COLUMN "connectionId",
DROP COLUMN "webhookEventId",
ALTER COLUMN "issuerId" SET NOT NULL;

-- DropTable
DROP TABLE "InvoicingConnection";

-- DropTable
DROP TABLE "InvoicingRef";
