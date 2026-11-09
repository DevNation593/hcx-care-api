-- Sessions of an account end when its second factor is enabled or reset: tokens carry this
-- version and are refused once it changes. Existing rows start at 0, as do tokens without it.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
