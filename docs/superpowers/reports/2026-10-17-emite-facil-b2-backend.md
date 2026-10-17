# Task2 backend report

Status: complete; independent specification and quality review approved at06af86b. API base1cda589;
implementation preserved from prior agent and completed in the existing API feature
worktree. No frontend edits or real
provider calls. Provider host remains manually configurable and blank in example env.

## Public frontend contract (Task3)

All paths use `/api/v1`; tenant routes start `/tenants/:tenantId`, require Bearer JWT
and core.billing section. Creation requires billing.create; list/detail/download require
billing.view. MASTER has these permissions, and PROFESIONAL/ASISTENTE may use these
invoice workflows with corresponding personal grants through the current role and
permission guards. Configuration endpoints remain MASTER-only. Dates serialize
as ISO strings. Secret fields are input-only and must never be refilled in the UI.

```ts
type InvoiceStatus = 'REQUESTED'|'PROCESSING'|'AUTHORIZED'|'REJECTED'|'FAILED';
type Environment = '1'|'2';
interface Point {
  branchId:string; establishmentId:string; emissionPointId:string;
  establishmentCode:string; emissionPointCode:string;
}
interface Connection {
  id:string; active:boolean; externalTenantId:string; taxpayerId:string;
  taxpayerName:string; taxpayerRuc:string; environment:Environment;
  hasApiKey:true; hasWebhookSecret:boolean; revision:number; validatedAt:string;
  webhookUrl:string|null; points:Point[];
}
interface ProviderTenant {
  id:string; name:string; status:'ACTIVE'|'SUSPENDED';
  role:'OWNER'|'ADMIN'|'BILLER'|'AUDITOR';
}
interface Taxpayer {
  id:string; ruc:string; legalName:string; tradeName:string|null;
  headOfficeAddress:string; defaultEnvironment:Environment;
  accountingRequired:boolean; specialTaxpayerCode:string|null;
  withholdingAgentCode:string|null;
  rimpeRegime:'NONE'|'EMPRENDEDOR'|'NEGOCIO_POPULAR'; productionEnabledAt:string|null;
}
interface Establishment {
  id:string; taxpayerId:string; code:string; address:string;
  emissionPoints:{id:string; establishmentId:string; code:string; enabled:boolean}[];
}
interface SriAttempt {
  id:string; operation:'RECEPTION'|'AUTHORIZATION'; outcome:string|null;
  sriStatus:string|null; httpStatus:number|null; startedAt:string; completedAt:string|null;
  messages:{identifier:string|null;message:string|null;additionalInfo:string|null;type:string|null}[];
}
interface InvoiceEvent {
  id:string; type:string; source:'API'|'DISPATCHER'|'RECONCILER'|'WEBHOOK';
  detail:Record<string,unknown>; createdAt:string;
}
interface InvoiceRequest {
  id:string; orderId:string; orderNumber:number|null; branchId:string|null;
  billingProfileId:string; status:InvoiceStatus; requiresReconciliation:boolean;
  replacesInvoiceRequestId:string|null; externalDocumentId:string|null;
  externalState:string|null; number:string|null; accessKey:string|null;
  authorizationNumber:string|null; authorizedAt:string|null;
  artifacts:{xml:boolean;ride:boolean}; attempts:number;
  lastError:null|{code:string;message:string;attempts?:SriAttempt[]};
  requestedAt:string; finishedAt:string|null; events?:InvoiceEvent[];
}
// Every POST response, including idempotent/collision replays, is a receipt.
// It never decrypts stored lastError/SRI content; use billing.view-protected GET for it.
type InvoiceReceipt = Omit<InvoiceRequest, 'lastError'> & {lastError:null};
```

| Method | Tenant-relative path | Input / response |
| --- | --- | --- |
| GET | `/invoicing/connection` |200 `Connection|null` |
| PUT | `/invoicing/connection` |`{taxpayerId:string,apiKey?:string,active?:boolean,webhookSecret?:string}` ->200 Connection |
| POST | `/invoicing/test` |`{apiKey?:string}` ->200 `{tenant:ProviderTenant,taxpayers:Taxpayer[]}` |
| GET | `/invoicing/options` |200 `{tenant:ProviderTenant,taxpayers:(Taxpayer & {establishments:Establishment[]})[]}` |
| PUT | `/branches/:branchId/emission-point` |`{establishmentId:string,emissionPointId:string}` ->200 Point |
| POST | `/orders/:id/invoice-requests` |No body; header `Idempotency-Key` ->202 InvoiceReceipt |
| GET | `/invoice-requests` |200 `{items:InvoiceRequest[],total:number,page:number,pageSize:number}` |
| GET | `/invoice-requests/:id` |200 InvoiceRequest including events |
| GET | `/invoice-requests/:id/xml` |200 binary XML |
| GET | `/invoice-requests/:id/ride` |200 binary PDF |

List filters: status, branchId, orderId, patientId, page(default1,min1),
pageSize(default20,min1,max100). POST initially has orderNumber/branchId=null;
list/detail populate them. All fiscal document fields start null. API-key max512,
taxpayer/establishment/point IDs nonempty max100. Keys are opaque strings. Header
idempotency regex `[A-Za-z0-9._:-]{1,100}`. No configurable provider URL in any DTO.

PUT omits apiKey to retain it. Omitted webhookSecret preserves it, `""` removes it;
otherwise exact `whsec_` + standard base64 encoding of32 bytes. `active` defaults true
on PUT. Test with an unsaved new key does not save it. Points are loaded only from
the saved connection's options. Save validates provider key and selected taxpayer.
Company/issuer lock after any request; keys rotate within that identity. Same-issuer
environment refresh allowed only with no active/uncertain requests/pending artifacts.

Example initial request JSON:

```json
{
  "id":"<request-uuid>","orderId":"<order-id>","orderNumber":null,"branchId":null,
  "billingProfileId":"<profile-id>","status":"REQUESTED","requiresReconciliation":false,
  "replacesInvoiceRequestId":null,"externalDocumentId":null,"externalState":null,
  "number":null,"accessKey":null,"authorizationNumber":null,"authorizedAt":null,
  "artifacts":{"xml":false,"ride":false},"attempts":0,"lastError":null,
  "requestedAt":"2026-10-17T12:00:00.000Z","finishedAt":null
}
```

Example protected error JSON:

```json
{"statusCode":409,"code":"INVOICE_RECONCILIATION_REQUIRED","message":"La emisión anterior tiene un resultado incierto. Espera su conciliación antes de volver a emitir o devolver pagos."}
```

Eligibility422 retains existing ORDER_NOT_BILLABLE or TREATMENT_DOCUMENTATION_INCOMPLETE
shape with missing/items. Other
errors are `{statusCode,code,message}` controlled Spanish. UI should display message
and actual SRI attempts when present. Do not interpret numeric SRI identifiers via an
invented dictionary. CUSTOMER_SYNC_REQUIRED means correct upstream customer fiscal
data; there is no customer PUT API. SIGNATURE_FAILED means correct/retry the SAME
document in emite-facil; remains PROCESSING and blocks refund/reissue.

Preserve client Idempotency-Key across network retries. Same key/order replays the same
request, another order409. POST202 is durable acceptance, not authorization. Poll detail
every5s while REQUESTED/PROCESSING or requiresReconciliation=true (including FAILED).
Only offer new request/new key for a known safe FAILED/REJECTED request. Never offer
refund/reissue for requiresReconciliation=true or AUTHORIZED. No optimistic success.
AUTHORIZED can have pending artifacts: enable each download only when its boolean is
true. Downloads use authentication, Content-Disposition, quoted SHA256 ETag and
Cache-Control private/no-store. 404 not ready;503 integrity failure. No cancel endpoint.

Public callback (outside tenant prefix): POST
`/api/v1/integrations/emite-facil/webhook/:connectionId` ->204. No JWT; raw signature
headers webhook-id/webhook-timestamp/webhook-signature required. Registered manually
upstream. webhookUrl=null if BACKEND_PUBLIC_URL missing/invalid. Polling works without
webhook. Limits: list/detail120/min, webhook300/min. Events never contain fiscal body
or SRI messages. Historical `/billing/invoices` endpoints remain read-only.

## Validation evidence and implementation notes

- Existing work resumed without discarding it. Current provider adapter98 tests retained.
- Connection race and malformed/absent webhook URL + artifact lease regressions:
  RED9failed/7passed, GREEN16passed.
- Resolver stale customer/product side effects and reference CAS: RED3failed/1passed,
  GREEN4passed.
- Treatment-version product reuse simulator: RED1failed/13passed (created2 products
  instead of1); GREEN14passed. Fiscal snapshot selects only treatmentVersionId for
  session-backed product identity; FREE retains its own item ID. No clinical content
  or patient names are copied into provider requests.
- Spanish controlled error messages: RED2failed; GREEN2passed.
- Real PostgreSQL baseline has28 migrations applied. `prisma validate` passed;
  `prisma migrate diff --from-url <disposable> --to-schema-datamodel prisma/schema.prisma
  --exit-code`: No difference detected, exit0. `tsc --noEmit` exit0.
- Rejection chain after safe replacement preflight failure: RED1failed/15passed
  (missing replacesDocumentId), GREEN16passed. Subsequent reissues retain the most
  recent known rejected provider document, even with intervening local FAILED requests.
- First full unit run exposed two missing legacy fixture updates: permission-controller
  catalog and subscription invoiceRequest delegate. Fixed those fixtures; no production
  fallback was added to hide missing persistence.
- Final full unit:123suites passed,2239tests passed,1skipped (2240total),74.209s.
- Combined PostgreSQL B2/B1 E2E:2suites,27tests passed (B2then16 + B1cash11).
  Final expanded B2:17/17 passed, including a POST response arriving after lease
  takeover, recovery with identical body/key, provider-reserved key without document,
  signature failure->same-document authorization, actual SRI reasons protected from
  event JSON, product reuse, early clinical completion, duplicate/out-of-order signed
  callbacks and real concurrent identical HTTP submissions.
- `npm run build`: exit0 (Prisma client generated locally, Nest compiled).
- Changed-file `prettier --check`: pass; ESLint exit0,0errors,1existing warning in
  subscription.service.ts (`updated` unused in unrelated feature-customization code).
- `git diff --check`: exit0. Git emitted Windows line-ending conversion notices only.

Reproducible verification commands (PowerShell; set disposable environment in the
process, never load a real .env):

```powershell
$env:DATABASE_URL = '<disposable localhost PostgreSQL URL from task brief>'
$env:DATABASE_URL_TEST = $env:DATABASE_URL
$env:JWT_ACCESS_SECRET = 'hcx-b2-disposable-access-secret'
$env:JWT_REFRESH_SECRET = 'hcx-b2-disposable-refresh-secret'
$env:REDIS_URL = ''
npx prisma migrate status
npx prisma validate
npx prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma --exit-code
npx tsc --noEmit
npx jest --runInBand
npx jest --config test/jest-e2e.json --runInBand test/invoicing.e2e-spec.ts test/cash-and-billing.e2e-spec.ts
npx jest --config test/jest-e2e.json --runInBand test/invoicing.e2e-spec.ts
$changed = @(git diff --name-only -- '*.ts'; git ls-files --others --exclude-standard -- '*.ts') | Sort-Object -Unique
npx prettier --check @changed
npx eslint @changed
npm run build
git diff --check
```

Known limits: real provider connectivity awaits the user's manually configured host;
no live acceptance/issuance was attempted. Existing test logs include NodeDEP0169
url.parse deprecation and expected notification warning/error fixtures. No new runtime
dependencies. No blocking implementation concern remains; independent review is the
next gate, and no merge/deployment has been performed.

Only disposable PostgreSQL localhost:55579/psic_clinic_test and a local HTTP simulator
were used. No real .env was copied, no provider credentials/live URL read or written,
no dependency installation and no production migrations. NODE_ENV=test disables worker
cron wrappers; tests call dispatch/reconcile explicitly. Multiple workers use row locks,
recoverable leases and CAS; all remote HTTP occurs outside long transactions.

Intents and resolved POST JSON are immutable encrypted values. The resolved body/hash
and unknown-outcome flag persist before invoice POST. Recovery retains that body and
stable hcx key despite changed profiles/catalogs/configuration.24h FAILED uncertainty
still blocks refunds/reissue and continues recovering its original request. Safe fiscal
rejection restores PAID and completed sessions BILLING_FAILED without touching payments.
Authorization marks only completed sessions BILLED; early care remains completable.

Pending authorized artifacts retry independently without revoking authorization. Files
are hashed, encrypted in existing FILE_STORAGE, CAS stored without overwriting valid
files, verified again on read, and downloads audited. Keep encryption/storage backups.

## Task2 review fix round1/5 — Important I1

Base: c7c1cce. The review reproduced a permission-boundary defect: a caller granted
billing.create without billing.view could replay an already-rejected request and receive
its decrypted lastError/SRI explanation in POST202. GET/list correctly denied that caller.

All three POST paths now select an acceptance receipt with lastError:null and short-circuit
before any stored-error decryption: new request, initial same-key replay, and P2002 unique
collision recovery. The existing billing.create/billing.view grants stay independent.
GET/list/detail continue returning protected explanations. The public contract above and
API_ENDPOINTS document the receipt explicitly; other response fields/endpoints are unchanged.

RED evidence before the production change:

- New focused service tests:2failed/2passed. Normal same-key replay and P2002 recovery
  exposed PRIVATE_SRI_EXPLANATION instead of lastError:null. The initial receipt and
  protected detail cases passed, isolating the disclosure to stored-error projection.
- Real PostgreSQL/provider-simulator E2E:1failed/17passed. An ASISTENTE with only
  billing.create created a request and received403 from both GET/list after rejection,
  yet its POST replay returned EXPLICACION_FISCAL_REAL.

GREEN evidence:

- `npx jest --runInBand src/invoicing/invoice-requests.service.spec.ts src/invoicing/invoice-errors.spec.ts src/common/permissions/permissions.spec.ts`:
  3suites/106tests passed. The four new service tests cover every POST path, assert
  replay does not invoke crypto.decrypt, and preserve decryption for protected GET.
- `npx jest --config test/jest-e2e.json --runInBand test/invoicing.e2e-spec.ts`:
  18/18passed on the same disposable PostgreSQL and local simulator. Create-only
  replay returns lastError:null; protected master detail still exposes the actual SRI
  explanation. The suite exited0. No real provider or data was accessed.
- `npx tsc --noEmit`: exit0. Scoped `prettier --check`: pass. Scoped ESLint: exit0,
  no errors/warnings. `git diff --check`: exit0 (Windows line-ending notice only).
  No full unit suite rerun was needed for this response-projection-only change; its prior result
  remains123suites/2239passed/1skipped.
