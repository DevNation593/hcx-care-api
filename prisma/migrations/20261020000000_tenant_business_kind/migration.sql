-- CreateEnum
CREATE TYPE "TenantBusinessKind" AS ENUM ('MEDICAL', 'AESTHETIC_STUDIO');

-- CreateEnum
CREATE TYPE "AestheticBookingStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AestheticPhotoPhase" AS ENUM ('BEFORE', 'AFTER');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "businessKind" "TenantBusinessKind" NOT NULL DEFAULT 'MEDICAL';

-- CreateTable
CREATE TABLE "AestheticClient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AestheticClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AestheticService" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durationMinutes" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "consentText" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AestheticService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AestheticBooking" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "AestheticBookingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AestheticBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AestheticSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "bookingId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AestheticSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AestheticConsent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "bodySnapshot" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AestheticConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AestheticPhoto" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "phase" "AestheticPhotoPhase" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AestheticPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AestheticClient_tenantId_lastName_idx" ON "AestheticClient"("tenantId", "lastName");

-- CreateIndex
CREATE INDEX "AestheticService_tenantId_isActive_name_idx" ON "AestheticService"("tenantId", "isActive", "name");

-- CreateIndex
CREATE INDEX "AestheticBooking_tenantId_staffId_startAt_endAt_idx" ON "AestheticBooking"("tenantId", "staffId", "startAt", "endAt");

-- CreateIndex
CREATE INDEX "AestheticBooking_tenantId_clientId_startAt_idx" ON "AestheticBooking"("tenantId", "clientId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "AestheticSession_bookingId_key" ON "AestheticSession"("bookingId");

-- CreateIndex
CREATE INDEX "AestheticSession_tenantId_clientId_startedAt_idx" ON "AestheticSession"("tenantId", "clientId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AestheticConsent_sessionId_key" ON "AestheticConsent"("sessionId");

-- CreateIndex
CREATE INDEX "AestheticConsent_tenantId_acceptedAt_idx" ON "AestheticConsent"("tenantId", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AestheticPhoto_storageKey_key" ON "AestheticPhoto"("storageKey");

-- CreateIndex
CREATE INDEX "AestheticPhoto_tenantId_sessionId_createdAt_idx" ON "AestheticPhoto"("tenantId", "sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "AestheticClient" ADD CONSTRAINT "AestheticClient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticService" ADD CONSTRAINT "AestheticService_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticBooking" ADD CONSTRAINT "AestheticBooking_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticBooking" ADD CONSTRAINT "AestheticBooking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AestheticClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticBooking" ADD CONSTRAINT "AestheticBooking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "AestheticService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticBooking" ADD CONSTRAINT "AestheticBooking_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticSession" ADD CONSTRAINT "AestheticSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticSession" ADD CONSTRAINT "AestheticSession_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "AestheticClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticSession" ADD CONSTRAINT "AestheticSession_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "AestheticService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticSession" ADD CONSTRAINT "AestheticSession_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticSession" ADD CONSTRAINT "AestheticSession_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "AestheticBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticConsent" ADD CONSTRAINT "AestheticConsent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticConsent" ADD CONSTRAINT "AestheticConsent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AestheticSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticConsent" ADD CONSTRAINT "AestheticConsent_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticPhoto" ADD CONSTRAINT "AestheticPhoto_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticPhoto" ADD CONSTRAINT "AestheticPhoto_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AestheticSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AestheticPhoto" ADD CONSTRAINT "AestheticPhoto_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Aesthetic data is only visible in the tenant context set by the API. Existing medical tables
-- keep their current policies; these new tables do not inherit them automatically.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'AestheticClient', 'AestheticService', 'AestheticBooking',
    'AestheticSession', 'AestheticConsent', 'AestheticPhoto'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING ("tenantId" = current_setting(''app.current_tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.current_tenant_id'', true))',
      table_name
    );
  END LOOP;
END $$;
