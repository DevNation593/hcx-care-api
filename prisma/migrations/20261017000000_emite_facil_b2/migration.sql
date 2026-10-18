-- CreateEnum
CREATE TYPE "InvoiceRequestStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'AUTHORIZED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "InvoicingConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "apiKeyEncrypted" TEXT NOT NULL,
    "webhookSecretEncrypted" TEXT,
    "externalTenantId" TEXT NOT NULL,
    "taxpayerId" TEXT NOT NULL,
    "taxpayerName" TEXT NOT NULL,
    "taxpayerRuc" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "validatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicingConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchEmissionPoint" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "establishmentId" TEXT NOT NULL,
    "emissionPointId" TEXT NOT NULL,
    "establishmentCode" TEXT NOT NULL,
    "emissionPointCode" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchEmissionPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoicingRef" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "syncedHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicingRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "billingProfileId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "InvoiceRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "clientIdempotencyKey" TEXT NOT NULL,
    "providerIdempotencyKey" TEXT NOT NULL,
    "snapshotEncrypted" TEXT NOT NULL,
    "providerBodyEncrypted" TEXT,
    "providerBodyHash" TEXT,
    "requiresReconciliation" BOOLEAN NOT NULL DEFAULT false,
    "replacesInvoiceRequestId" TEXT,
    "rootRequestId" TEXT NOT NULL,
    "externalDocumentId" TEXT,
    "externalState" TEXT,
    "number" TEXT,
    "accessKey" TEXT,
    "authorizationNumber" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "xmlStorageKey" TEXT,
    "xmlSha256" TEXT,
    "rideStorageKey" TEXT,
    "rideSha256" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorEncrypted" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "InvoiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRequestEvent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "invoiceRequestId" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "webhookEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoicingConnection_tenantId_key" ON "InvoicingConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchEmissionPoint_branchId_key" ON "BranchEmissionPoint"("branchId");

-- CreateIndex
CREATE INDEX "BranchEmissionPoint_connectionId_idx" ON "BranchEmissionPoint"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicingRef_connectionId_kind_localId_key" ON "InvoicingRef"("connectionId", "kind", "localId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRequest_providerIdempotencyKey_key" ON "InvoiceRequest"("providerIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRequest_replacesInvoiceRequestId_key" ON "InvoiceRequest"("replacesInvoiceRequestId");

-- CreateIndex
CREATE INDEX "InvoiceRequest_tenantId_requestedAt_idx" ON "InvoiceRequest"("tenantId", "requestedAt");

-- CreateIndex
CREATE INDEX "InvoiceRequest_status_nextAttemptAt_leaseUntil_idx" ON "InvoiceRequest"("status", "nextAttemptAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "InvoiceRequest_orderId_idx" ON "InvoiceRequest"("orderId");

-- CreateIndex
CREATE INDEX "InvoiceRequest_rootRequestId_idx" ON "InvoiceRequest"("rootRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRequest_tenantId_clientIdempotencyKey_key" ON "InvoiceRequest"("tenantId", "clientIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRequest_connectionId_externalDocumentId_key" ON "InvoiceRequest"("connectionId", "externalDocumentId");

-- CreateIndex
CREATE INDEX "InvoiceRequestEvent_invoiceRequestId_createdAt_idx" ON "InvoiceRequestEvent"("invoiceRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRequestEvent_connectionId_webhookEventId_key" ON "InvoiceRequestEvent"("connectionId", "webhookEventId");

-- AddForeignKey
ALTER TABLE "InvoicingConnection" ADD CONSTRAINT "InvoicingConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchEmissionPoint" ADD CONSTRAINT "BranchEmissionPoint_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchEmissionPoint" ADD CONSTRAINT "BranchEmissionPoint_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InvoicingConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoicingRef" ADD CONSTRAINT "InvoicingRef_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InvoicingConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InvoicingConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_billingProfileId_fkey" FOREIGN KEY ("billingProfileId") REFERENCES "BillingProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_replacesInvoiceRequestId_fkey" FOREIGN KEY ("replacesInvoiceRequestId") REFERENCES "InvoiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequestEvent" ADD CONSTRAINT "InvoiceRequestEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "InvoicingConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequestEvent" ADD CONSTRAINT "InvoiceRequestEvent_invoiceRequestId_fkey" FOREIGN KEY ("invoiceRequestId") REFERENCES "InvoiceRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "InvoiceRequest_one_blocking_per_order" ON "InvoiceRequest" ("orderId") WHERE "status" IN ('REQUESTED', 'PROCESSING', 'AUTHORIZED') OR "requiresReconciliation" = true;
