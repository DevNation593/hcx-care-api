# Final B2 fix1 scoped re-review

Reviewed API `6bbd802..d2d9d8fcd963d8f12fe66ee8172774489383c865`. Web remains at the previously reviewed `26be62b`.

**I1: ADDRESSED. Scoped quality/spec verdict: Approved. Final whole-branch verdict: ready for integration, with no remaining Critical or Important finding from this review.** No merge, publish or deployment approval is implied.

## Scope and method

Read the supplied two-file fix diff once and the fix report, applying the original final-review I1 and previously reviewed B2 contract. Focused source checks covered pre-lock completion reads and the existing Serializable retry helper. Inspected the recorded final GREEN, negative-mutation, affected E2E and unit logs. These execution results are supplied evidence, not independently rerun commands. No new execution doubt remained that justified another test run.

No source/index/branch edits, subagents, full-suite/build reruns, provider calls, dependency installation or real environment/database access. Only this review artifact was written; the original final-review.md remains the record of the pre-fix finding.

## Synchronization and I1 verification

The new lock at `src/treatment-sessions/treatment-sessions.service.ts:583` selects the previously observed InvoiceRequest by both id and tenant with `FOR UPDATE`, before the session status/completedAt transition at line586. `loadForCommand`, `findSession` and `loadSessionFacts` perform reads before this point; they do not acquire session/order write locks that would invert the fiscal worker's order.

- **Fiscal transaction commits first:** PostgreSQL Serializable cannot successfully lock the obsolete row version selected by completion's earlier snapshot after a concurrent fiscal update. The existing helper handles both Prisma P2034 and raw-query P2010/SQLSTATE40001 (`src/prisma/serializable-transaction.ts:8`), restarts the full transaction and reapplies tenant RLS context. The retry therefore reloads the current invoice/session instead of writing the stale BILLING_PENDING result.
- **Completion locks first:** `applyDocument` obtains its InvoiceRequest lock first (`src/invoicing/invoice-worker.service.ts:235`) and must wait for completion. Its later session update sees the committed non-null completedAt. Safe `failed()` likewise updates/locks InvoiceRequest before releasing order/session state. The common lock closes both interleavings without making provider HTTP part of the clinical transaction.
- **Authorization:** Both orderings finish with a completed BILLED session.
- **Rejection and safe failure:** Fiscal-first completion reloads the absence of a blocking request and reaches the existing sequential CLINICAL_COMPLETE result; completion-first finalization reaches BILLING_FAILED. Neither retains an obsolete pending state; both remain billable.
- **Uncertain FAILED and other blocking states:** The existing status/requiresReconciliation predicate and state mapping are unchanged. An uncertain FAILED still matches the selected row, receives the same lock and maps to BILLING_PENDING. No-invoice and clinical-completion-required paths retain their prior behavior.

The id/tenant predicate stays within the caller's existing tenant-scoped transaction and adds no permission or RLS bypass. The shared InvoiceRequest-before-session lock order is consistent with both fiscal finalization paths; no new lock-order cycle was identified. The bounded three-attempt retry behavior is unchanged. Terminal monotonicity, lease/CAS, uncertainty/idempotency rules, payments, artifacts and provider contracts were not altered.

## Regression evidence

The six added E2E cases at `test/invoicing.e2e-spec.ts:855` and `:932` execute real HTTP completion, Prisma transactions and worker methods for AUTHORIZED, REJECTED and safe FAILED. Test wrappers pause around real reads/transitions; they do not fabricate database return values. The reverse-order cases query actual `pg_blocking_pids` at line967 to prove the worker waits on completion's backend.

Recorded evidence is consistent with the fix and the original reproduced failure:

- Initial worker-first RED: three stale BILLING_PENDING failures; configuration prerequisite passed.
- Final focused GREEN: six concurrency cases plus configuration passed, 17 unrelated cases skipped.
- Negative mutation removing exactly the lock: all six regressions failed, comprising three stale-state failures and three missing lock waits. Restoring the lock returned all six to GREEN.
- Directly affected validation: B2 invoicing24 + B1 cash11 =35/35 E2E passed; session/state/Serializable helper370/370 unit tests passed. TypeScript, scoped zero-warning ESLint, Prettier and diff checks are reported successful.

The inspected logs show the expected case names, assertions and totals. Existing Node DEP0169 output remains a baseline warning. No unnecessary full-suite/build repetition was performed during this re-review.

## Findings and final disposition

**Critical:** None remaining.

**Important:** None remaining. Original final-review I1 is resolved by the shared lock and the real concurrency regressions in both execution orders.

**Minor M1:** Streaming body-size overflow coverage remains deferred and nonblocking. The previously reviewed production limits exist; this fix does not change that boundary or establish a production overflow defect.

Combining the original whole-branch review with this scoped correction, API at d2d9d8f and web at26be62b are ready for integration. The previous broad validation evidence retains its documented timing/limits. Real provider connectivity/issuance, manually configured provider host and production migration/deployment remain intentionally unverified; no such action was performed or claimed here.
