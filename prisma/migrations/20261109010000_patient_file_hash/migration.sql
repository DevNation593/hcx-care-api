-- The SHA-256 of the decrypted bytes of a patient file. A file attached to an encounter is part
-- of its signature and can no longer be removed once the encounter is signed. Nullable: files
-- uploaded before get their hash when their encounter is signed.
ALTER TABLE "PatientFile" ADD COLUMN "contentHash" TEXT;
