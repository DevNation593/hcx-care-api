# Final B2 whole-branch integration review

Reviewed API `808609a..6bbd802c826b7a3e7f9df700ff29806d21ec6934` and web `8c0048b..26be62b356358cf82af561afe78d39366127eed7` on 2026-10-17.

**Verdict: changes required.** One Important concurrency defect remains. No Critical defect found. The integration otherwise follows the updated contract and the stronger receipt-only uncertainty ruling.

## Scope and method

Read the final brief, binding B2 supplement and relevant original design sections, source-backed provider audit, permanent backend/frontend/delivery reports, and scoped review/fix reports. Read both supplied whole-branch diff packages in sequential chunks. Focused unchanged-source checks resolved role/permission guard behavior, existing HTTP transport and secret handling, query-key compatibility, serializable retry behavior, and the clinical completion concurrency risk below. No application source, index, branch or HEAD was changed. No subagents, provider calls, dependency installation, real environment reads, full-suite reruns or builds.

One focused Node/Prisma concurrency harness ran against the explicitly supplied disposable PostgreSQL at `127.0.0.1:55579/psic_clinic_test`. It transpiled the actual TypeScript in memory, executed the actual `TreatmentSessionsService.complete` / `transition` and `InvoiceWorkerService.applyDocument`, and used real Prisma transactions. Unrelated eligibility/authorization/detail/audit/encounter dependencies were stubbed; the invoice read, completion status derivation, version-checked session write, worker transaction and worker session predicate were real. A barrier paused completion immediately after its invoice read. Existing disposable fixture fields and the inserted worker event were restored in `finally`. No harness file was written.

## Important I1 — Concurrent early clinical completion can leave an authorized session permanently pending

**Locations:**

- API `src/treatment-sessions/treatment-sessions.service.ts:567`: completion reads the blocking invoice with ordinary `findFirst` inside its serializable transaction.
- API `src/treatment-sessions/treatment-sessions.service.ts:581`: it derives `BILLING_PENDING` from that observed PROCESSING state, then sets `completedAt` at line584.
- API `src/invoicing/invoice-worker.service.ts:232`: `applyDocument` uses a separate transaction at default isolation; line235 locks InvoiceRequest only.
- API `src/invoicing/invoice-worker.service.ts:291`: authorization updates sessions only when `completedAt` is already non-null (line295).

**Reproduction confirmed with the focused real-PostgreSQL harness:**

1. An early-invoiced session is IN_PROGRESS with `completedAt:null`; its invoice is PROCESSING.
2. `complete` reads the invoice as PROCESSING, then pauses before its session write.
3. `applyDocument(AUTHORIZED)` commits. Its session update matches no row because completion has not set `completedAt` yet.
4. `complete` resumes, derives BILLING_PENDING from its earlier read, writes `completedAt`, and commits successfully.

Observed output:

```json
{"traces":["complete reads invoice PROCESSING","worker authorization commits while completedAt is null","complete commits session BILLING_PENDING"],"invoiceStatus":"AUTHORIZED","sessionStatus":"BILLING_PENDING","clinicallyCompleted":true,"expectedSessionStatus":"BILLED","confirmedMismatch":true}
```

**Impact:** Clinically completed and fiscally authorized care retains BILLING_PENDING instead of BILLED. This is durable: subsequent authorized processing collects artifacts, and terminal `applyDocument` does not reapply session transitions. The existing sequential early-authorization E2E does not cover this overlap. A serializable completion transaction alone does not prevent the demonstrated mixed-isolation interleaving. The analogous safe-rejection/failure release predicate also warrants a regression while correcting the shared transition boundary; that variant was not separately executed in this review.

**Required fix:** Coordinate completion and fiscal finalization on a consistent shared synchronization/transaction boundary before deriving and writing the session's financial state. Handle conflicts with the existing retry policy and keep provider HTTP outside long transactions. Add a deterministic concurrency regression reproducing the barrier ordering above and asserting that both completion and authorization succeed with the final session BILLED. Cover rejection/safe failure overlap as appropriate so a finalized invoice cannot leave a newly completed session in an obsolete pending state. Do not merely change labels or depend on another webhook/poll to repair it.

## Minor M1 — Deferred streaming body-size overflow coverage

API `src/invoicing/provider/emite-facil.provider.ts:346` enforces the accumulated byte limit and cancels the reader on overflow. Call sites bound error bodies to64KiB (line418), ordinary successful JSON to10MiB (line433), and artifacts to20MiB (line617). The deferred real-HTTP overflow test remains **Minor coverage**, not an established production defect or a blocker. A later test should exercise chunked overflow and verify the sanitized error/cancellation behavior. No evidence justifies inventing a missing production bound.

## Integration checks with no additional blocking finding

- Web DTOs, tenant-relative paths, POST202 receipt, supported configuration/point inputs, list filters/pagination and authenticated Blob endpoints match the API. Saved-issuer catalogs drive points; environment comes from the provider; the browser never receives or sends a provider credential directly upstream.
- Existing RolesGuard delegates declared grantable permissions to PermissionGuard. Configuration is MASTER-only; billing.create and billing.view remain independent. All three POST result paths use `includeError:false`; protected GET/list retain actual encrypted-at-rest SRI explanations. Web protected queries/downloads respect billing.view and fail closed for unknown delegated grants. Faktur history is retained.
- Durable acceptance is serializable, tenant/key scoped and protected by the partial blocking uniqueness index. Monthly usage counts roots in the Ecuador fiscal month. Snapshots contain fiscal fields; resolved encrypted POST JSON/hash and stable provider key persist before POST uncertainty is marked. Prior uncertainty survives later configuration/auth errors and 24h FAILED status, blocks refunds/reissue and recovers the same body/key.
- Claims/leases/CAS and network boundaries, rejected-document replacement continuity, immutable issuer identity and quiescent same-issuer environment refresh agree with the contract. SIGNATURE_FAILED remains PROCESSING; unknown provider states stay conservative. Webhook signature/raw bytes, durable dedupe and authoritative document checks are implemented. Artifacts are hashed, encrypted, independently retried, verified on read and audited.
- The web's local UNCERTAIN state survives old/different-ID safe-final GET candidates and later409/422 errors. Only same-key POST receipt settles it, while observed authorization is absorbing. Discovery remains5000ms with billing.view; active/uncertain requests and authorized missing artifacts continue polling. The billing422 extension preserves clinical ApiError.missing. Spanish status/copy and existing UI components are retained.
- The migration adds the invoicing models and constraints without deleting Faktur data. Operational documents require manual global host configuration, encryption and persistent storage, describe the optional manually registered webhook, and distinguish disposable simulator validation from live issuance. Blank provider-host examples are intentional.

## Verification limits and disposition

Reviewed reported evidence: API123suites/2239passed/1skipped, final permission checks106passed and B2 E2E18passed, B1cash11passed; web115suites/1012passed/1skipped and final focused93passed; documented schema/build/static checks. These remain supplied prior command outcomes, not rerun claims. Baseline Node/notification/DOM warnings and the documented preexisting subscription warning are not B2 blockers.

Real provider connectivity, issuance and production migration/deployment remain intentionally unverified and were not attempted. No merge/push/publish/deploy was requested or performed.

**Disposition:** Fix I1 and run its focused regression plus directly affected checks, then obtain a scoped re-review. M1 may remain deferred. No other Critical/Important fix is required by this review.
