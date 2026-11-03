-- CreateEnum
CREATE TYPE "RimpeRegime" AS ENUM ('NONE', 'EMPRENDEDOR', 'NEGOCIO_POPULAR');

-- AlterTable
ALTER TABLE "BranchEmissionPoint" ADD COLUMN     "establishmentAddress" TEXT,
ADD COLUMN     "issuerId" TEXT,
ALTER COLUMN "connectionId" DROP NOT NULL,
ALTER COLUMN "establishmentId" DROP NOT NULL,
ALTER COLUMN "emissionPointId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceRequest" ADD COLUMN     "emailAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "emailedAt" TIMESTAMP(3),
ADD COLUMN     "issuerId" TEXT,
ADD COLUMN     "sequential" TEXT,
ADD COLUMN     "signedXmlSha256" TEXT,
ADD COLUMN     "signedXmlStorageKey" TEXT,
ALTER COLUMN "connectionId" DROP NOT NULL,
ALTER COLUMN "providerIdempotencyKey" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceRequestEvent" ADD COLUMN     "issuerId" TEXT,
ALTER COLUMN "connectionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "InvoicingIssuer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruc" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "headOfficeAddress" TEXT NOT NULL,
    "accountingRequired" BOOLEAN NOT NULL,
    "specialTaxpayerCode" TEXT,
    "withholdingAgentCode" TEXT,
    "rimpeRegime" "RimpeRegime" NOT NULL DEFAULT 'NONE',
    "environment" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "certificateEncrypted" TEXT,
    "certificatePasswordEncrypted" TEXT,
    "certificateSubject" TEXT,
    "certificateSerial" TEXT,
    "certificateValidTo" TIMESTAMP(3),
    "certificateSha256" TEXT,
    "certificateRucVerified" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicingIssuer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceSequence" (
    "id" TEXT NOT NULL,
    "issuerId" TEXT NOT NULL,
    "establishmentCode" TEXT NOT NULL,
    "emissionPointCode" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "InvoiceSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoicingIssuer_tenantId_key" ON "InvoicingIssuer"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceSequence_issuerId_establishmentCode_emissionPointCod_key" ON "InvoiceSequence"("issuerId", "establishmentCode", "emissionPointCode", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "BranchEmissionPoint_issuerId_establishmentCode_emissionPoin_key" ON "BranchEmissionPoint"("issuerId", "establishmentCode", "emissionPointCode");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRequest_issuerId_accessKey_key" ON "InvoiceRequest"("issuerId", "accessKey");

-- AddForeignKey
ALTER TABLE "InvoicingIssuer" ADD CONSTRAINT "InvoicingIssuer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceSequence" ADD CONSTRAINT "InvoiceSequence_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "InvoicingIssuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchEmissionPoint" ADD CONSTRAINT "BranchEmissionPoint_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "InvoicingIssuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "InvoicingIssuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequestEvent" ADD CONSTRAINT "InvoiceRequestEvent_issuerId_fkey" FOREIGN KEY ("issuerId") REFERENCES "InvoicingIssuer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

