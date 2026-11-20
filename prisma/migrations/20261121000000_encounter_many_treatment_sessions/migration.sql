-- An encounter may now hold several treatment sessions: the unique index becomes a plain one.
-- DropIndex
DROP INDEX "TreatmentSession_encounterId_key";

-- CreateIndex
CREATE INDEX "TreatmentSession_encounterId_idx" ON "TreatmentSession"("encounterId");
