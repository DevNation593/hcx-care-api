# Task3 frontend report — emite-facil B2

Status: complete; independent specification and quality review approved at `26be62b`.
Frontend base: `8c0048b`. Backend contract reviewed: Task2 report including fix1,
backend approved at `06af86b`. No backend source mutations.

## Commit and scope

- Branch: `feat/emite-facil-b2`.
- Commit: `fe0aa7692ff52d81241745ed69db2de2a1d5b99f`
  (`feat(billing): configure and request emite-facil invoices`).
- Follow-up commits: `c5f7312` and `26be62b` preserve the idempotency key of
  locally uncertain attempts until the same-key POST receipt, or an observed
  authorization blocks all new submissions. The focused final checks passed
  93 tests in six suites, TypeScript, scoped lint and formatting.
  The scoped independent review approved fix2 with no remaining Critical or
  Important finding.
- Worktree: `D:/Proyectos Personales/Saas - Psic/web/.worktrees/emite-facil-b2`.
- 21 files changed, 1623 insertions, 26 deletions. Working tree clean after commit.
- All product mutations stayed in this web worktree. This scratch report is the
  explicitly authorized exception in the API worktree. No subagents/reviewers spawned.
- No provider repository, live provider, DB, production data, credentials, or actual
  `.env` files were accessed. No dependency installation, merge, push, or deployment.
  Existing node_modules junction reused. Existing API-worktree Prettier executable
  was used read-only to format new web files; no API code/dependency changes.

## Resulting behavior

- Added exact public DTOs in `src/types/invoicing.ts`, tenant-relative HTTP methods
  in `src/lib/api/invoicing-api.ts`, and tenant-scoped React Query hooks in
  `src/hooks/useInvoicing.ts`. The existing API client supplies HCX Bearer auth.
  There is no browser/provider direct integration or tenant provider-host field.
- Added `InvoicingSettings` at `/admin/billing`. Its form/query subtree mounts only
  for canonical `isMasterRole`; assistants and professionals never call MASTER
  connection/options endpoints, even with billing grants.
- Key and webhook-secret inputs start empty. Saved state uses only `hasApiKey` /
  `hasWebhookSecret`. Typed test keys stay in local form state, never a query cache.
  Testing does not save; changing a key invalidates prior taxpayer choices, including
  a pending old test response. Save omits blank credentials to preserve them; the
  explicit remove-secret control sends the supported empty string.
- Real taxpayer choices display the provider-selected Pruebas/Producción environment;
  there is no unsupported environment save field. Initial test yields taxpayers only.
  Catalogs/establishments/enabled points load from options after the connection is
  saved. Branch assignments use the exact point endpoint and real external IDs.
- Saved webhook URLs can be copied and registered manually upstream. The optional
  webhook secret has no subscription-management calls. A missing URL clearly says
  polling works without webhook. Connection/options/point errors stay visible and
  retryable; secrets remain unfilled.
- `InvoiceRequestPanel({order,eligibility})` is mounted inside the existing OrderDetail,
  keyed only by order ID. The existing background-refetch preservation remains.
  Requests require independent billing.create, eligibility, and a paid order.
  The UUID is generated at submission and kept across lost responses/refetch errors;
  a retry on a now-locked order still sends that original header. No optimistic
  authorization is shown. A receipt is displayed as Solicitada/its actual status.
- A fresh key is offered only for known safe FAILED/REJECTED requests, with eligibility
  and order PAID again. requiresReconciliation never enables a fresh-key reissue.
  Known authorization removes retry/reissue controls and shows the no-annulment notice.
- billing.view independently controls list/detail/download calls. Create-only callers
  use the POST receipt (`lastError:null`) and see that result/downloads require view;
  they never query protected invoice APIs or display protected explanations. Unknown
  delegated permissions fail closed using the existing hook's fallback argument.
- Polling runs every 5000ms for REQUESTED/PROCESSING, any requiresReconciliation outcome,
  or AUTHORIZED with either artifact still missing. It stops at a completed final
  outcome. Receipt acceptance and final protected detail invalidate order, eligibility,
  order lists, billable sessions, treatment-session lists/details and patient sessions.
  Invalidations are not awaited by the mutation, so a failed refresh cannot turn a
  durable receipt into a failed POST or destroy the submission key.
- Invoice summaries show durable number/access key/authorization/time, actual protected
  error messages and SRI attempt messages/identifiers without an invented dictionary.
  Each artifact button depends on its own stored boolean. Downloads use authenticated
  apiClient Blob requests, an attached temporary anchor, and URL revocation after click.
  Download errors are shown inline.
- Added Facturas to Caja, with server status/branch/patient filters, server pagination,
  accurate statuses and authenticated downloads. Patient history adds new invoices by
  server patientId filter and retains the separate original read-only history. No
  snapshot inspection or patient names are needed for new invoice filtering.
- Original Faktur/history data and safe old document links remain read-only, restricted
  by billing.view. Legacy próxima-release/B1 expectations were adapted, while existing
  history and clinic-settings/Faktur-retirement tests remain valid. INVOICED order
  labels now say En facturación, including order-list filter wording.
- Extended ApiError minimally with separate typed `billingEligibility`. Actual HTTP422
  `ORDER_NOT_BILLABLE` / `TREATMENT_DOCUMENTATION_INCOMPLETE` missing/items survive
  normalization and render through the existing EligibilityChecklist. Clinical-only
  `ApiError.missing: MissingRequirement[]` and existing normalization callers remain
  compatible. Known codes and item shape are validated; raw Axios transport is not
  exposed. Removed the checklist's stale no-emission comment.
- Kept existing Spanish card/input/button/alert styles, responsive wrapping and grids.
  No marketing/design-system/Sites changes.

## RED/GREEN evidence

Commands executed from the web feature worktree with installed dependencies only.
Every Vitest invocation was capped at two workers.

1. `npx vitest run src/lib/api/client.test.ts --maxWorkers=2 --minWorkers=1`
   - RED: 1 failed / 19 passed. New billing422 assertion expected billingEligibility
     (missing + patient items), but normalized runtime error dropped it.
   - GREEN after compatible transport extension: 20/20 passed.
   - Existing clinical-normalization assertions continued passing.
2. `npx vitest run src/features/cash/invoicing.test.tsx --maxWorkers=2 --minWorkers=1`
   - Initial module-missing discovery was followed by empty component stubs so the
     meaningful RED ran as assertions: 13 failed / 3 passed. Missing key fields,
     issuer/point controls, emission/status/422 checklist, polling and download UI.
   - Implemented DTO/API/hooks/configuration/list/panel: 15 passed / 1 failed; remaining
     fake-timer assertion needed the additional 1ms React Query notification flush.
     Advancing 5000ms plus that notification flush yielded 16/16 GREEN.
3. Integration RED with updated billing-page, patient-history, cash-page and order-detail
   requirements: `npx vitest run src/features/billing/billing-page.test.tsx
   src/features/billing/patient-invoices-tab.test.tsx src/features/cash/order-detail.test.tsx
   src/features/cash/cash-page.test.tsx --maxWorkers=2 --minWorkers=1`
   - RED: 6 failed / 37 passed: absent settings, missing Facturas tab/new patient list,
     old history query still issued without view, absent emission in the order.
   - GREEN including transport and B2 cases: 6 suites, 79/79 passed.
4. Added terminal-result regression before the corresponding refresh behavior:
   - RED: 1 failed / 16 passed, eligibility cache remained non-invalidated after REJECTED.
   - GREEN: 17/17 after invalidating related order/session queries on protected final detail.
5. Added lost-response-resolved-as-authorized regression before removing retry control:
   - RED: 1 failed / 17 passed; Reintentar emisión remained visible after AUTHORIZED.
   - GREEN: 18/18 after limiting unresolved-response retry controls to nonfinal outcomes.
6. Final hardening assertions also verify unknown delegated grants and actual protected
   SRI explanations. Final focused command:

```powershell
npx vitest run src/features/cash/invoicing.test.tsx src/lib/api/client.test.ts src/features/cash/order-detail.test.tsx src/features/cash/cash-page.test.tsx src/features/billing/billing-page.test.tsx src/features/billing/patient-invoices-tab.test.tsx --maxWorkers=2 --minWorkers=1
```

Result: 6 suites / 83 tests passed, exit0, 14.33s. This final focused run includes all
20 B2 integration cases, 20 transport cases and the updated original integration tests.
Key headers are checked through the actual new API wrapper, not a fabricated hook input.
The 422 panel fixture uses the exact billingEligibility transport extension proven by
client.test.ts. Polling covers uncertain FAILED -> AUTHORIZED with partial artifacts ->
AUTHORIZED with both artifacts -> stop. Reissue checks a new header only after rejection.

## Global validation and build

- `npm test -- --maxWorkers=2 --minWorkers=1`: exactly one full Vitest run;
  115 suites passed, 1012 tests passed, 1 skipped (1013 total), exit0, 151.10s.
  That run collected the then18-case B2 file. The two later hardening assertions plus
  Spanish attempt-operation label/formatting were covered by the final focused83 above;
  no unnecessary second blanket run was performed.
- `npm run lint`: exit0, no errors or warnings.
- `npm run type-check`: exit0.
- Final changed-file `npx eslint @changed --max-warnings=0`: exit0, no errors/warnings.
- `git diff --check`: exit0 before commit. Git emitted only Windows LF/CRLF notices
  for new files during staging; no whitespace errors.
- Self-review checked the DTO/endpoint table, payload/header shapes, tenant scoping,
  strict MASTER mount boundary, fail-closed independent grants, cached secret metadata,
  key lifetime, safe reissue, terminal refresh, artifact polling and Blob cleanup.

Build required environment/network setup, not a B2 fix:

1. Plain `npm run build` failed because sandbox networking denied Google Fonts Inter
   (`EACCES`, existing root layout). No product/font change or permanent mock was made.
2. Re-run with network escalation and NEXT_TELEMETRY_DISABLED=1 compiled successfully
   and passed Next lint/types, then failed prerender because the clean worktree has no
   real `.env`: existing production guard requires NEXT_PUBLIC_API_BASE_URL.
3. Complete reproducible successful command (approved sandbox escalation for Google
   Fonts; values are reserved build-only HCX URLs in the child process):

```powershell
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:NEXT_PUBLIC_API_BASE_URL = 'https://hcx-build.invalid/api/v1'
$env:NEXT_PUBLIC_APP_URL = 'https://hcx-build.invalid'
npm run build
```

Final build: exit0. Compiled successfully; lint and validity of types passed;
47/47 static pages generated; optimization/build traces completed. B2 routes included
/admin/billing (10.2kB), /cash (5.63kB), /cash/orders/[id] (5.6kB) and patient pages.
These values were not written to any env file, and no EMITE_FACIL_API_URL was inferred,
configured, or used by the frontend. No real HCX/provider service was called.

## Original warnings and limitations (separate from B2)

- Existing Vite CJS Node API deprecation at Vitest startup.
- Existing expected Web Push error fixture logging in usePushNotifications.test.tsx.
- Existing validateDOMNesting warnings in PatientBillingProfiles and SeatLimitModal.
- Existing skipped plan-catalog test.
- Build reports outdated caniuse-lite/Browserslist data and existing edge-runtime
  static-generation warning. No unrelated fixes or dependency updates were made.
- The initial clean-worktree build failures were font networking and absent public HCX
  build variables, resolved above without reading/copying real env files.
- Live provider connectivity/real issuance remain intentionally unattempted; user will
  configure the global server provider host manually. No blocking implementation
  concern identified in this task; independent fresh review is the next gate.

## Task3 review fix round1/5 — Important I1

Status: DONE, ready for controller's independent re-review. Scope limited to accepted
I1, the panel's current-attempt uncertainty, its discovery polling and regressions.
Base: `fe0aa7692ff52d81241745ed69db2de2a1d5b99f`.
Fix commit: `c5f73127f13912c46344b71bd212f1850e2ba9d5`
(`fix(billing): retain uncertain replacement attempt identity`). Working tree clean.
Three web files changed: invoice-request-panel.tsx, useInvoicing.ts, invoicing.test.tsx.
No subagents, backend changes, provider/DB calls, env changes or installs.

Root cause confirmed: safeFinal referred to the old rejected/safe FAILED request.
When a replacement POST response was lost, that predecessor incorrectly disabled
uncertainRetry, and the next click cleared the replacement UUID. Also, a successful
empty-list response disabled the only discovery interval before a detail ID existed.

Changes:

- A local unresolvedAttempt records the predecessor request ID independently from the
  latest observed fiscal state after a transport/5xx/unknown POST failure. Its retained
  UUID remains the retry identity even while that predecessor stays safely final or
  background refreshes fail. A fresh-key action is disabled until the current attempt
  is recovered via POST or discovered with a different request ID.
- Starting a legitimate fresh replacement clears the previous local receipt, so it
  cannot keep masking the replacement subsequently discovered in the order list.
- useInvoiceRequests accepts an optional discoverUnresolvedAttempt flag. Only the
  order panel sets it while locally unresolved. It forces the existing5000ms interval
  even if the response is empty or still contains only the old safe final request.
- Receipt recovery/discovery clears local uncertainty. Normal REQUESTED/PROCESSING,
  reconciliation and pending-authorized-artifact polling continue through the original
  DTO gates. Once this replacement is itself safely FAILED/REJECTED, a new UUID may be
  requested. AUTHORIZED and requiresReconciliation still prevent fresh-key reissue.
- The independent billing.view enabled gate remains authoritative for discovery;
  create-only callers make no list/detail requests even after a lost POST. An idle
  empty list without local uncertainty remains unpolled.

RED before production changes:

```powershell
npx vitest run src/features/cash/invoicing.test.tsx --maxWorkers=2 --minWorkers=1
```

Result:23 cases,3failed/20passed. Both prior-status variants (REJECTED and safeFAILED)
reproduced different first/second Idempotency-Key header values after a lost replacement
response plus failed background refresh. The empty-list case still had exactly2GET
calls after5000ms (expected another discovery call), reproducing the related gap.

GREEN:

- Same focused file after fix:23/23passed.
- Added targeted guard assertions: polling continues while the predecessor is still
  safe final; a newly discovered safeFAILED replacement ends discovery polling and
  permits a different UUID; ordinary empty lists remain idle; create-only lost-response
  cases never read invoice endpoints. Expanded B2 file:26/26passed.
- Final applicable focused run:

```powershell
npx vitest run src/features/cash/invoicing.test.tsx src/features/cash/order-detail.test.tsx src/features/cash/cash-page.test.tsx src/features/billing/billing-page.test.tsx src/features/billing/patient-invoices-tab.test.tsx src/lib/api/client.test.ts --maxWorkers=2 --minWorkers=1
npm run type-check
npx eslint src/features/cash/invoice-request-panel.tsx src/hooks/useInvoicing.ts src/features/cash/invoicing.test.tsx --max-warnings=0
```

Results:6suites/89tests passed, exit0,16.51s; TypeScript exit0; changed-file ESLint exit0
with no errors/warnings. Existing authorization, uncertain FAILED, artifact completion,
independent grants and stable initial-submission-key cases all remain green.

- Installed Prettier check for the three changed files, using --single-quote
  --print-width100: pass (`All matched files use Prettier code style!`).
- git diff --check: exit0. Git's existing Windows LF/CRLF notices only.
- Scoped self-review confirmed state/UUID lifetime, receipt precedence, discovery interval
  and permission boundaries. No further blocking concern identified.
- No additional blanket suite or production build run: this change is limited to panel
  state and an opt-in existing-query interval; the required focused checks passed and
  no broader doubt arose. Earlier full-suite/build evidence remains recorded above.
- Existing Vite CJS deprecation was the only focused startup warning; unrelated original
  warnings were not modified. No live provider validation attempted.

## Task3 review fix round2/5 — Important I1, late history / receipt identity

Status: DONE, ready for controller's scoped re-review.
Base: `c5f73127f13912c46344b71bd212f1850e2ba9d5`.
Commit: `26be62b356358cf82af561afe78d39366127eed7`
(`fix(billing): acknowledge uncertain attempts only by receipt`). Web worktree clean.
Only invoice-request-panel.tsx and invoicing.test.tsx changed (122insertions/19deletions).
No backend/hook/DTO/API changes, timestamp/clock heuristics, provider/DB calls, env
changes, installs, subagents or full-suite/build repetition.

The controller's conservative ruling supersedes fix1's different-ID assumption:
list/detail have no client idempotency key, so a candidate with another ID cannot
prove it belongs to the locally uncertain POST. This applies equally to delayed old
history, a distinct actor's request, initial pending discovery and failed discovery.

Changes:

- Removed predecessor-ID comparison and any GET-candidate-based acknowledgement.
  Panel-local attemptOutcome has only SETTLED / UNCERTAIN / AUTHORIZED states.
- A lost/5xx/unknown POST retains its UUID and UNCERTAIN state. GET still displays
  available progress/status, but REQUESTED, PROCESSING, REJECTED or safeFAILED candidates
  do not release the key or enable a fresh-key action.
- Reintentar emisión resubmits the retained key. Only successful POST receipt recovery
  settles that attempt; its request ID then anchors the current receipt/detail. If this
  acknowledged request is safely final, the existing fresh-reissue gate can use a new UUID.
- A later retry's HTTP409/422 error is not an acknowledgement: it updates the visible
  error but preserves UNCERTAIN and the same key across further retries.
- Observed AUTHORIZED is absorbing for the mounted order panel. It blocks submission
  and all emission/reissue controls permanently, including after stale rejection or
  empty list responses, and cannot be overwritten by a later POST success/failure.
  Original authorized-artifact polling still handles missing downloads.
- Existing order-filtered5000ms discovery stays active for local uncertainty through
  pending/error/empty/old/distinct candidate lists. The hook's existing billing.view
  guard still prevents create-only reads; ordinary empty lists remain unpolled.
- Test mocks now reset before installing their defaults so an intentionally failing
  regression cannot leave unused one-time response behavior for the following test.

RED evidence before the production fix:

```powershell
npx vitest run src/features/cash/invoicing.test.tsx --maxWorkers=2 --minWorkers=1
```

After isolating mock one-time queues between tests:28cases,4failed/24passed, no unhandled
errors. The pending/error initial-history variants both reproduced UUID A -> UUID B after
lostPOST then late oldREJECTED. The distinct-ID safeFAILED case wrongly offered Volver a
emitir before a same-key receipt, and the discovered REQUESTED case wrongly removed retry.

GREEN after the panel change:28/28passed. Added explicit409/422 preservation cases and
extended the authorization observation case to stale rejected and empty responses:
30/30passed. The extra empty-after-authorization assertion caught a visual gate omission
in a targeted RED run (Emitir factura could reappear although submit already rejected it);
adding the same permanent authorization condition to the rendered button yielded
30/30GREEN again. No dictionary, date comparison or contract extension was introduced.

Final exact-HEAD focused verification:

```powershell
npx vitest run src/features/cash/invoicing.test.tsx src/features/cash/order-detail.test.tsx src/features/cash/cash-page.test.tsx src/features/billing/billing-page.test.tsx src/features/billing/patient-invoices-tab.test.tsx src/lib/api/client.test.ts --maxWorkers=2 --minWorkers=1
npm run type-check
npx eslint src/features/cash/invoice-request-panel.tsx src/features/cash/invoicing.test.tsx --max-warnings=0
```

- Focused result:6suites/93tests passed, exit0,14.37s. B2 file includes30cases.
- TypeScript exit0. Scoped ESLint exit0, no warnings/errors.
- Existing installed Prettier --check --single-quote --print-width100 on the two changed
  files: pass. git diff --check: exit0. Only existing Windows LF/CRLF notices.
- Self-review verified UUID reset only for acknowledged safe-final attempts; GET
  candidates never acknowledge; AUTHORIZED is absorbing; known retry errors preserve
  uncertainty; forced discovery and permission/artifact gates retain their prior behavior.
- No additional full Vitest/build: changes are limited to the panel's uncertainty state
  and targeted regressions; original full/build evidence remains above. Final focused
  tests still cover known predecessors, failed refresh, create-only/noGET, uncertainty,
  authorization and pending artifacts.
- Existing Vite CJS startup deprecation only. No new blocking concern identified.
