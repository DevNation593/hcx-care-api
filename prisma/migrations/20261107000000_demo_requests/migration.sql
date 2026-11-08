-- Demo requests sent from the public site (/contacto), followed up by the platform administrator.

CREATE TYPE "DemoRequestStatus" AS ENUM ('NEW', 'CONTACTED', 'CLOSED');

CREATE TABLE "DemoRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clinic" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "teamSize" TEXT NOT NULL,
    "message" TEXT,
    "status" "DemoRequestStatus" NOT NULL DEFAULT 'NEW',
    "privacyAcceptedAt" TIMESTAMP(3) NOT NULL,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DemoRequest_status_createdAt_idx" ON "DemoRequest"("status", "createdAt");
