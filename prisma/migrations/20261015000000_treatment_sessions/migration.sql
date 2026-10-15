-- CreateEnum
CREATE TYPE "ConsentTemplateVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ConsentDocumentStatus" AS ENUM ('PRESENTED', 'SIGNED', 'REFUSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentEventType" AS ENUM ('PRESENTED', 'SIGNED', 'REFUSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentSignerRole" AS ENUM ('PATIENT', 'REPRESENTATIVE');

-- CreateEnum
CREATE TYPE "TreatmentSessionStatus" AS ENUM ('INTAKE_IN_PROGRESS', 'READY_FOR_CONSENT', 'CONSENTED', 'IN_PROGRESS', 'CLINICAL_COMPLETE', 'CONSENT_REFUSED', 'CONSENT_REVOKED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "SessionMediaPhase" AS ENUM ('BEFORE', 'AFTER', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEntity" ADD VALUE 'TREATMENT_SESSION';
ALTER TYPE "AuditEntity" ADD VALUE 'CONSENT_DOCUMENT';

-- AlterTable
ALTER TABLE "PatientFile" ADD COLUMN     "phase" "SessionMediaPhase",
ADD COLUMN     "treatmentSessionId" TEXT;

-- CreateTable
CREATE TABLE "Treatment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "specialtyId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Treatment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "treatmentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "taxRatePercent" DECIMAL(5,2) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "formDefinitionId" TEXT,
    "formVersion" INTEGER,
    "consentTemplateVersionId" TEXT,
    "requirements" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreatmentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentTemplateVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" "ConsentTemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "treatmentSessionId" TEXT NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" "ConsentDocumentStatus" NOT NULL DEFAULT 'PRESENTED',
    "presentedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signedAt" TIMESTAMP(3),
    "refusedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "pdfStorageKey" TEXT,
    "pdfChecksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentSignature" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "signerRole" "ConsentSignerRole" NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerIdentification" TEXT NOT NULL,
    "relationship" TEXT,
    "understood" BOOLEAN NOT NULL,
    "questionsAnswered" BOOLEAN NOT NULL,
    "marketingPhotos" BOOLEAN NOT NULL DEFAULT false,
    "signatureStorageKey" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "type" "ConsentEventType" NOT NULL,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "branchId" TEXT,
    "appointmentId" TEXT,
    "treatmentVersionId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "formRecordId" TEXT,
    "consentDocumentId" TEXT,
    "status" "TreatmentSessionStatus" NOT NULL DEFAULT 'INTAKE_IN_PROGRESS',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "procedureNotes" TEXT,
    "cancellationReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreatmentSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Treatment_tenantId_isActive_idx" ON "Treatment"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Treatment_tenantId_name_key" ON "Treatment"("tenantId", "name");

-- CreateIndex
CREATE INDEX "TreatmentVersion_tenantId_idx" ON "TreatmentVersion"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentVersion_treatmentId_version_key" ON "TreatmentVersion"("treatmentId", "version");

-- CreateIndex
CREATE INDEX "ConsentTemplate_tenantId_isActive_idx" ON "ConsentTemplate"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentTemplate_tenantId_name_key" ON "ConsentTemplate"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ConsentTemplateVersion_tenantId_idx" ON "ConsentTemplateVersion"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentTemplateVersion_templateId_version_key" ON "ConsentTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "ConsentDocument_tenantId_patientId_createdAt_idx" ON "ConsentDocument"("tenantId", "patientId", "createdAt");

-- CreateIndex
CREATE INDEX "ConsentDocument_treatmentSessionId_idx" ON "ConsentDocument"("treatmentSessionId");

-- CreateIndex
CREATE INDEX "ConsentDocument_templateVersionId_idx" ON "ConsentDocument"("templateVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentSignature_documentId_key" ON "ConsentSignature"("documentId");

-- CreateIndex
CREATE INDEX "ConsentSignature_tenantId_idx" ON "ConsentSignature"("tenantId");

-- CreateIndex
CREATE INDEX "ConsentSignature_operatorId_idx" ON "ConsentSignature"("operatorId");

-- CreateIndex
CREATE INDEX "ConsentEvent_tenantId_idx" ON "ConsentEvent"("tenantId");

-- CreateIndex
CREATE INDEX "ConsentEvent_documentId_idx" ON "ConsentEvent"("documentId");

-- CreateIndex
CREATE INDEX "ConsentEvent_actorId_idx" ON "ConsentEvent"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentSession_encounterId_key" ON "TreatmentSession"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "TreatmentSession_formRecordId_key" ON "TreatmentSession"("formRecordId");

-- CreateIndex
CREATE INDEX "TreatmentSession_tenantId_patientId_createdAt_idx" ON "TreatmentSession"("tenantId", "patientId", "createdAt");

-- CreateIndex
CREATE INDEX "PatientFile_treatmentSessionId_idx" ON "PatientFile"("treatmentSessionId");

-- AddForeignKey
ALTER TABLE "PatientFile" ADD CONSTRAINT "PatientFile_treatmentSessionId_fkey" FOREIGN KEY ("treatmentSessionId") REFERENCES "TreatmentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Treatment" ADD CONSTRAINT "Treatment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Treatment" ADD CONSTRAINT "Treatment_specialtyId_fkey" FOREIGN KEY ("specialtyId") REFERENCES "Specialty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentVersion" ADD CONSTRAINT "TreatmentVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentVersion" ADD CONSTRAINT "TreatmentVersion_treatmentId_fkey" FOREIGN KEY ("treatmentId") REFERENCES "Treatment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentVersion" ADD CONSTRAINT "TreatmentVersion_formDefinitionId_fkey" FOREIGN KEY ("formDefinitionId") REFERENCES "FormDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentVersion" ADD CONSTRAINT "TreatmentVersion_consentTemplateVersionId_fkey" FOREIGN KEY ("consentTemplateVersionId") REFERENCES "ConsentTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentTemplate" ADD CONSTRAINT "ConsentTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentTemplateVersion" ADD CONSTRAINT "ConsentTemplateVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentTemplateVersion" ADD CONSTRAINT "ConsentTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ConsentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentDocument" ADD CONSTRAINT "ConsentDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentDocument" ADD CONSTRAINT "ConsentDocument_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentDocument" ADD CONSTRAINT "ConsentDocument_treatmentSessionId_fkey" FOREIGN KEY ("treatmentSessionId") REFERENCES "TreatmentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentDocument" ADD CONSTRAINT "ConsentDocument_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "ConsentTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentSignature" ADD CONSTRAINT "ConsentSignature_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentSignature" ADD CONSTRAINT "ConsentSignature_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ConsentDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentSignature" ADD CONSTRAINT "ConsentSignature_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ConsentDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_treatmentVersionId_fkey" FOREIGN KEY ("treatmentVersionId") REFERENCES "TreatmentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_formRecordId_fkey" FOREIGN KEY ("formRecordId") REFERENCES "SpecialtyRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentSession" ADD CONSTRAINT "TreatmentSession_consentDocumentId_fkey" FOREIGN KEY ("consentDocumentId") REFERENCES "ConsentDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
