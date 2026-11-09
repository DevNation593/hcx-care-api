-- Phase 4 of the clinical record: consents for clinical procedures, antivirus status of patient
-- files and two-factor sign-in. Only nullable columns and columns with defaults are added, and the
-- consent document's session becomes optional: existing rows keep working as they are.
--   * A consent document belongs to a treatment session or, new, to a clinical encounter.
--   * Patient files stored before scanning existed are NOT_SCANNED.
--   * No user has two-factor sign-in until they enrol, and no clinic requires it until it says so.

-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('NOT_SCANNED', 'CLEAN', 'INFECTED');

-- AlterTable
ALTER TABLE "TenantSettings" ADD COLUMN     "requireMfa" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mfaEnabledAt" TIMESTAMP(3),
ADD COLUMN     "mfaLastStep" INTEGER,
ADD COLUMN     "mfaPendingSecret" TEXT,
ADD COLUMN     "mfaRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mfaSecret" TEXT;

-- AlterTable
ALTER TABLE "PatientFile" ADD COLUMN     "scanEngine" TEXT,
ADD COLUMN     "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
ADD COLUMN     "scannedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ConsentDocument" ADD COLUMN     "encounterId" TEXT,
ADD COLUMN     "procedureName" TEXT,
ALTER COLUMN "treatmentSessionId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ConsentSignature" ADD COLUMN     "witnessName" TEXT;

-- CreateIndex
CREATE INDEX "ConsentDocument_encounterId_idx" ON "ConsentDocument"("encounterId");

-- AddForeignKey
ALTER TABLE "ConsentDocument" ADD CONSTRAINT "ConsentDocument_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Exactly one owner per document.
ALTER TABLE "ConsentDocument" ADD CONSTRAINT "ConsentDocument_one_owner_check"
  CHECK (("treatmentSessionId" IS NULL) <> ("encounterId" IS NULL));
