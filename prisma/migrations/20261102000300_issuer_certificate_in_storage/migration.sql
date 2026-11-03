-- The issuer's .p12 moves from the database to FILE_STORAGE, encrypted with the tenant key; the
-- row keeps only its key, the SHA-256 of the plaintext bytes and the metadata. A certificate still
-- kept in the database is not moved: it and its metadata are cleared, and the revision moves so a
-- stale form is refused, until the clinic uploads it again.
ALTER TABLE "InvoicingIssuer" ADD COLUMN "certificateStorageKey" TEXT;

UPDATE "InvoicingIssuer"
SET "certificatePasswordEncrypted" = NULL,
    "certificateSubject" = NULL,
    "certificateSerial" = NULL,
    "certificateValidTo" = NULL,
    "certificateSha256" = NULL,
    "certificateRucVerified" = false,
    "revision" = "revision" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "certificateEncrypted" IS NOT NULL
   OR "certificatePasswordEncrypted" IS NOT NULL
   OR "certificateSha256" IS NOT NULL;

ALTER TABLE "InvoicingIssuer" DROP COLUMN "certificateEncrypted";
