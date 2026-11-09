-- Clinical orders, their results and follow-ups. An order moves through its study (sample, lab,
-- result) and then through the clinical steps that must be recorded apart: the review of each
-- result, the contact with the patient and the closing of its follow-ups. Only new tables and
-- columns with defaults: existing rows are untouched. The old "general.orders" form records stay
-- as they are.

-- CreateEnum
CREATE TYPE "ClinicalOrderType" AS ENUM ('LABORATORY', 'IMAGING', 'PATHOLOGY', 'PROCEDURE', 'THERAPY', 'INTERCONSULTATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ClinicalOrderPriority" AS ENUM ('ROUTINE', 'PREFERENTIAL', 'URGENT');

-- CreateEnum
CREATE TYPE "ClinicalOrderStatus" AS ENUM ('ORDERED', 'SAMPLE_COLLECTED', 'SENT_TO_LAB', 'PENDING_REVIEW', 'REVIEWED', 'PATIENT_CONTACTED', 'COMPLETED', 'CANCELLED', 'NOT_PERFORMED');

-- CreateEnum
CREATE TYPE "ClinicalResultStatus" AS ENUM ('PENDING_REVIEW', 'REVIEWED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ResultReviewDecision" AS ENUM ('NO_FURTHER_ACTION', 'FOLLOW_UP_REQUIRED', 'REPEAT_REQUIRED');

-- CreateEnum
CREATE TYPE "PatientContactChannel" AS ENUM ('IN_PERSON', 'PHONE', 'VIDEO_CALL', 'MESSAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "ClinicalFollowUpStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- AlterEnum


ALTER TYPE "AuditEntity" ADD VALUE 'CLINICAL_ORDER';
ALTER TYPE "AuditEntity" ADD VALUE 'CLINICAL_RESULT';
ALTER TYPE "AuditEntity" ADD VALUE 'CLINICAL_FOLLOW_UP';

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "orderResultAlertDays" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "resultReviewAlertDays" INTEGER NOT NULL DEFAULT 3;

-- CreateTable
CREATE TABLE "ClinicalOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "orderedById" TEXT NOT NULL,
    "encounterId" TEXT,
    "orderType" "ClinicalOrderType" NOT NULL,
    "priority" "ClinicalOrderPriority" NOT NULL DEFAULT 'ROUTINE',
    "studyName" TEXT NOT NULL,
    "indication" TEXT,
    "provider" TEXT,
    "externalReference" TEXT,
    "status" "ClinicalOrderStatus" NOT NULL DEFAULT 'ORDERED',
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultDueAt" TIMESTAMP(3),
    "sampleCollectedAt" TIMESTAMP(3),
    "sampleNotes" TEXT,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "completionNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,
    "signedAt" TIMESTAMP(3),
    "contentHash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalResult" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "enteredById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "studyDate" TIMESTAMP(3),
    "issuedBy" TEXT,
    "content" TEXT,
    "fileId" TEXT,
    "recordId" TEXT,
    "contentHash" TEXT NOT NULL,
    "status" "ClinicalResultStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewDecision" "ResultReviewDecision",
    "reviewNote" TEXT,
    "appointmentNeeded" BOOLEAN NOT NULL DEFAULT false,
    "communicatedAt" TIMESTAMP(3),
    "communicatedById" TEXT,
    "communicationChannel" "PatientContactChannel",
    "communicationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalFollowUp" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "orderId" TEXT,
    "resultId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignedToId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" "ClinicalFollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closureNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicalOrder_tenantId_patientId_orderedAt_idx" ON "ClinicalOrder"("tenantId", "patientId", "orderedAt");

-- CreateIndex
CREATE INDEX "ClinicalOrder_tenantId_status_idx" ON "ClinicalOrder"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ClinicalOrder_tenantId_orderedById_status_idx" ON "ClinicalOrder"("tenantId", "orderedById", "status");

-- CreateIndex
CREATE INDEX "ClinicalOrder_encounterId_idx" ON "ClinicalOrder"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalResult_fileId_key" ON "ClinicalResult"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalResult_recordId_key" ON "ClinicalResult"("recordId");

-- CreateIndex
CREATE INDEX "ClinicalResult_tenantId_status_idx" ON "ClinicalResult"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ClinicalResult_tenantId_patientId_idx" ON "ClinicalResult"("tenantId", "patientId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalResult_orderId_version_key" ON "ClinicalResult"("orderId", "version");

-- CreateIndex
CREATE INDEX "ClinicalFollowUp_tenantId_status_dueDate_idx" ON "ClinicalFollowUp"("tenantId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "ClinicalFollowUp_tenantId_assignedToId_status_idx" ON "ClinicalFollowUp"("tenantId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "ClinicalFollowUp_tenantId_patientId_idx" ON "ClinicalFollowUp"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "ClinicalFollowUp_orderId_idx" ON "ClinicalFollowUp"("orderId");

-- AddForeignKey
ALTER TABLE "ClinicalOrder" ADD CONSTRAINT "ClinicalOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalOrder" ADD CONSTRAINT "ClinicalOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalOrder" ADD CONSTRAINT "ClinicalOrder_orderedById_fkey" FOREIGN KEY ("orderedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalOrder" ADD CONSTRAINT "ClinicalOrder_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalResult" ADD CONSTRAINT "ClinicalResult_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalResult" ADD CONSTRAINT "ClinicalResult_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalResult" ADD CONSTRAINT "ClinicalResult_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ClinicalOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalResult" ADD CONSTRAINT "ClinicalResult_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalResult" ADD CONSTRAINT "ClinicalResult_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "PatientFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalResult" ADD CONSTRAINT "ClinicalResult_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "SpecialtyRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalResult" ADD CONSTRAINT "ClinicalResult_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalFollowUp" ADD CONSTRAINT "ClinicalFollowUp_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalFollowUp" ADD CONSTRAINT "ClinicalFollowUp_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalFollowUp" ADD CONSTRAINT "ClinicalFollowUp_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ClinicalOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalFollowUp" ADD CONSTRAINT "ClinicalFollowUp_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "ClinicalResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalFollowUp" ADD CONSTRAINT "ClinicalFollowUp_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalFollowUp" ADD CONSTRAINT "ClinicalFollowUp_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

