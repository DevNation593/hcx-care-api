# Final B2 integration fix 1 — clinical/fiscal finalization race

Scope: API feature worktree `api/.worktrees/emite-facil-b2`, branch
`feat/emite-facil-b2`, starting HEAD `6bbd802`. Addresses final-review Important I1.
Read `final-review.md`; did not edit it, the permanent delivery report, or the plan.
No subagents/reviewers, provider repository, real environment files, live database,
web worktree, root dev branch, dependency installs, push, merge or deployment.

The only production change is five lines in `TreatmentSessionsService.complete`:
after selecting a blocking early invoice, acquire `SELECT ... FOR UPDATE` on its
id and tenant before the session transition. `loadForCommand` and
`loadSessionFacts` only read before that lock. This preserves the worker's
InvoiceRequest-before-TreatmentSession lock order. A fiscal transaction that
already changed the selected row causes PostgreSQL Serializable to reject the
stale locking read; the existing P2010/SQLSTATE40001 and P2034 retry helper reloads
the invoice/session. A worker arriving later waits until completion commits, then
its completedAt predicate sees the completed session. No provider HTTP was added
inside a transaction; worker implementation, retry rules and financial state
mapping remain unchanged.

Added six real PostgreSQL E2E cases to the existing B2 simulator suite. HTTP
completion, service implementations, all database reads/writes, row locks,
serializable retry, safe failure path and fiscal events ran against the disposable
database. The named command logs below were temporary review evidence; this
report preserves their outcomes. Test-local
wrappers insert barriers around the invoice read or transition and restore their
spies in finally; they do not return fabricated database results. The reverse
ordering polls pg_blocking_pids for the actual completion backend, so its
assertion observes a PostgreSQL wait instead of inferring one from elapsed time.

| Fiscal outcome | Worker commits after invoice read, before completion lock | Completion locks first, worker waits |
| --- | --- | --- |
| AUTHORIZED | Completion retries and finishes BILLED | Worker finishes BILLED |
| REJECTED (NOT_AUTHORIZED provider state) | Completion retries and finishes CLINICAL_COMPLETE | Worker finishes BILLING_FAILED |
| Safe FAILED before POST (customer mismatch) | Completion retries and finishes CLINICAL_COMPLETE | Worker finishes BILLING_FAILED |

For already rejected/safely failed invoices, CLINICAL_COMPLETE is the existing
sequential completion behavior because no blocking invoice remains. For failure
after clinical completion, BILLING_FAILED is the worker's existing behavior. Both
remain billable and neither retains obsolete BILLING_PENDING. Uncertain FAILED
requests still match the original requiresReconciliation filter and stay pending;
the uncertainty policy was not changed. Existing no-invoice and clinical-gated
completion paths are unaffected by the conditional lock.

## RED / GREEN evidence

All E2E commands used only the explicitly provided disposable PostgreSQL at
`127.0.0.1:55579/psic_clinic_test`, via DATABASE_URL_TEST. Throwaway
JWT_ACCESS_SECRET/JWT_REFRESH_SECRET and empty REDIS_URL were supplied to the
process. setup-e2e applies the existing database safety assertion and test-only
mail/storage/encryption settings. The provider is the existing local HTTP
simulator. No .env was read or edited by the agent. An initial application
bootstrap run lacked the throwaway JWT secret and failed before the tests; the
environment was corrected before collecting behavioral RED evidence.

1. Before production change, added the three worker-first barrier tests and ran:

```powershell
npx jest --config test/jest-e2e.json --runInBand --runTestsByPath test/invoicing.e2e-spec.ts --testNamePattern 'requires configuration|serializes early invoice'
```

RED: 3 failures, 1 passing configuration prerequisite, 17 skipped. All three
failures were the intended stale BILLING_PENDING final state (expected BILLED for
authorization; CLINICAL_COMPLETE for rejection/safe failure). Log:
`final-fix-1-red.log`. After the five-line source change, GREEN: 4 passed/17
skipped, exit0,19.375s (`final-fix-1-green.log`).

2. Added the three reverse-order cases, extracted the shared test-only fixture,
and ran:

```powershell
npx jest --config test/jest-e2e.json --runInBand --runTestsByPath test/invoicing.e2e-spec.ts --testNamePattern 'requires configuration|serializes early invoice|waits for clinical completion'
```

GREEN: 7 passed/17 skipped, exit0,20.803s (`final-fix-1-focused.log`).

3. Sensitivity check: temporarily removed exactly the new five-line lock block
and ran the same six-case command. All six regressions failed as intended: three
stale final statuses, three absent PostgreSQL lock waits. Configuration still
passed. Exit1,25.156s (`final-fix-1-mutation.log`). Restored the exact lock block
and reran the same command; final GREEN:7passed/17skipped,exit0,19.661s
(`final-fix-1-final-green.log`). All six new tests therefore detect removal of the
production synchronization and pass again with it restored.

## Directly affected validation

```powershell
npx jest --config test/jest-e2e.json --runInBand --runTestsByPath test/invoicing.e2e-spec.ts test/cash-and-billing.e2e-spec.ts
npx jest --runInBand --runTestsByPath src/treatment-sessions/treatment-sessions.service.spec.ts src/treatment-sessions/session-state.spec.ts src/prisma/serializable-transaction.spec.ts
npx tsc --noEmit --incremental false
npx eslint src/treatment-sessions/treatment-sessions.service.ts test/invoicing.e2e-spec.ts --max-warnings=0
npx prettier --check src/treatment-sessions/treatment-sessions.service.ts test/invoicing.e2e-spec.ts
git diff --check
```

- B2 invoicing24 + B1 cash11 =35/35 passed,2suites,exit0,31.581s
  (`final-fix-1-e2e.log`). Run in band because the suites share and reset the
  dedicated disposable database.
- Direct unit coverage:370/370 passed,3suites,exit0,17.021s
  (`final-fix-1-unit.log`).
- TypeScript exit0; scoped ESLint exit0 with zero warnings; Prettier and
  whitespace checks pass. Only two source/test files are changed.
- Existing Node DEP0169 url.parse deprecation appeared in E2E; no new warning.
- No whole unit-suite/build rerun: the production delta is the shared row lock,
  covered in both orderings with real PostgreSQL plus the affected existing
  billing, session and retry suites. Prior whole-branch evidence remains valid
  as prior evidence only.

Self-review: no session/order write occurs before the shared invoice lock in
completion; applyDocument and safe failed() take/write the invoice before
order/session writes. Existing invoice terminal monotonicity, uncertainty,
idempotency and payment paths are preserved. M1 streaming overflow coverage
remains the reviewer's explicitly deferred Minor item. Live provider issuance
and production migration/deployment were neither attempted nor claimed.

Committed source/tests only as
`d2d9d8fcd963d8f12fe66ee8172774489383c865`
(`fix(invoicing): synchronize clinical and fiscal finalization`). Post-commit
`git status --short` was empty. At implementation time the scratch report and
logs were ignored by Git and no permanent report or review artifact was changed.
