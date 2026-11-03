-- Dropping "requiresReconciliation" in 20261102000100 also dropped this partial index, whose WHERE
-- used that column. It keeps at most one pending or authorized request per order, which the
-- request service relies on (P2002 -> INVOICE_REQUEST_IN_PROGRESS). Prisma does not model partial
-- indexes, so it lives only here.
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceRequest_one_blocking_per_order" ON "InvoiceRequest" ("orderId") WHERE "status" IN ('REQUESTED', 'PROCESSING', 'AUTHORIZED');
