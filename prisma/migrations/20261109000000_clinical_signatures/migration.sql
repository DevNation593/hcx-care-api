-- Clinical signatures. Closing an encounter signs it and its records; a record outside any
-- encounter is signed when it is saved. A signed record is never changed nor removed: it is
-- corrected by an addendum that points to it. Only nullable columns are added, so existing rows
-- keep working: encounters closed before this have no signature but are treated as final.

ALTER TABLE "Encounter"
  ADD COLUMN "signedAt" TIMESTAMP(3),
  ADD COLUMN "signedById" TEXT,
  ADD COLUMN "contentHash" TEXT;

ALTER TABLE "SpecialtyRecord"
  ADD COLUMN "signedAt" TIMESTAMP(3),
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "amendsRecordId" TEXT,
  ADD COLUMN "amendmentReason" TEXT;

-- A record is corrected by at most one addendum; an addendum is corrected by its own.
CREATE UNIQUE INDEX "SpecialtyRecord_amendsRecordId_key" ON "SpecialtyRecord"("amendsRecordId");

ALTER TABLE "SpecialtyRecord" ADD CONSTRAINT "SpecialtyRecord_amendsRecordId_fkey"
  FOREIGN KEY ("amendsRecordId") REFERENCES "SpecialtyRecord"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
