# Task 1 report — executable Emite Fácil HTTP boundary

Implemented only the five requested `src/invoicing/provider` files. No module/controller/model, provider repository, production database, dependency installation, environment-file access or remote provider calls were involved. All HTTP tests use ephemeral loopback servers and the actual Node `fetch` implementation.

Commit: `16c3d85` (`feat(invoicing): add audited Emite Facil HTTP adapter`). Only the five provider files were committed in that task; this report was archived after the independent review approved the pagination fix at `1cda589`.

## Evidence

The tests were written before the adapter behavior. Initial missing-module RED was followed by compilable interface/stub scaffolding and an assertion-level RED:

```powershell
npx jest --runInBand --runTestsByPath src/invoicing/provider/emite-facil.provider.spec.ts src/invoicing/provider/webhook-signature.spec.ts
```

RED: exit 1, 2 failed suites, **65 failed / 21 passed / 86 total tests**. The invoice test failed at the unimplemented `client()` and valid webhook signature tests failed `Expected: true / Received: false`.

The initially green implementation passed 87 tests. The subsequently requested SRI extension was separately RED using `--testNamePattern 'SRI'` (3 failed tests; unimplemented method). The unknown-state compatibility addition was separately RED using `--testNamePattern 'unknown provider state'` (1 failed test; parser returned `INVALID_RESPONSE`), before its implementation.

Final GREEN with the command above: exit 0, **2 passed suites / 91 passed tests**, including a real fifteen-second stalled response-body timeout. Also ran:

```powershell
npx prettier --write src/invoicing/provider/*.ts
npx eslint src/invoicing/provider/*.ts
npx tsc --noEmit --incremental false
git diff --check
```

All exited 0. ESLint emitted no diagnostics. No full API suite is claimed here; root integration validation follows subsequent tasks.

## Exact consuming interface

`EmiteFacilProvider` is injectable and takes `ConfigService`. Its constructor does not read/validate configuration, allowing an unconfigured application to boot. `client(apiKey: string, correlationId?: string): InvoicingProvider` reads global `EMITE_FACIL_API_URL` and returns a separate client. The singleton factory never stores API credentials. URL validation occurs when making a client, and produces a sanitized configuration error.

```ts
interface InvoicingProvider {
  getTenant(): Promise<Tenant>;
  listTaxpayers(): Promise<Taxpayer[]>;
  listEstablishments(taxpayerId: string): Promise<Establishment[]>;
  listEmissionPoints(taxpayerId: string, establishmentId: string): Promise<EmissionPoint[]>;
  listTaxRates(): Promise<TaxRate[]>;
  findCustomer(idType: string, idNumber: string): Promise<Customer | null>;
  createCustomer(profile: CustomerProfile): Promise<Customer>;
  findProduct(sku: string): Promise<Product | null>;
  createProduct(product: ProductInput): Promise<Product>;
  createInvoice(body: InvoiceBody, key: string): Promise<IssuedDocument>;
  getDocument(id: string): Promise<ProviderDocument>;
  getSriAttempts(id: string): Promise<SriAttempt[]>;
  getArtifact(id: string, kind: ArtifactKind): Promise<ProviderArtifact>;
}
```

All types are exported from `invoicing-provider.ts`, which is the authoritative field-level definition. Types preserve the audited wire names and string decimals; there is no floating-point conversion. Catalog types expose UUIDs, issuer environment `'1'|'2'`, three-character establishment/point codes, `enabled`, and separate `taxCode/rateCode/rate` values. `listEmissionPoints` validates the establishment against the selected taxpayer first, because the upstream points endpoint accepts only `establishmentId`.

- `CustomerProfile`: required `idType,idNumber,name`; optional nullable `email,address,phone`. `Customer` adds `id`, with all three contact fields present and nullable. Searches compare both identity fields exactly, return stored data unchanged, and never use PUT/PATCH. The caller must compare the fiscal snapshot and raise `CUSTOMER_SYNC_REQUIRED` on mismatch. Duplicate customer creation remains a typed data error; the caller can repeat lookup on a race.
- `ProductInput`: required `sku,name,unitPrice,ivaRateCode`; `Product` adds `id`. Exact SKU search uses all necessary pages. There is no implicit product update or substitution on partial match. Duplicate creation remains a typed data error for caller reconciliation.
- `InvoiceBody`: required `taxpayerId,establishmentCode,emissionPointCode,customerId,lines,payments`; optional nullable `issueDate,currency,replacesDocumentId`. Each line has `productId,quantity` and optional nullable `unitPrice,discount`; each payment has `methodCode,amount`. No tenant/environment/clientId/auth exchange fields are introduced. The body and stable key are sent exactly as given.
- `IssuedDocument`: `id,state,statusUrl`. `statusUrl` is informational; no provider-controlled URL is ever fetched. HTTP 202 remains asynchronous acceptance, not authorization.
- `ProviderDocument`: complete audited document detail including immutable fiscal customer, lines, taxes, payments, number/sequence/access key, nullable authorization data and replacement links. UUIDs, object/array types, decimals and nullability are validated at runtime, and unknown properties are omitted. `KnownDocumentState` lists the ten audited states. `DocumentState` also permits bounded nonempty future strings (maximum 60 characters), allowing core to keep unknown states PROCESSING and record `PROVIDER_STATE` rather than failing an invoice.
- `SriAttempt`: `id,operation:'RECEPTION'|'AUTHORIZATION',outcome:string|null,sriStatus:string|null,httpStatus:number|null,startedAt,completedAt:string|null,messages:SriMessage[]`. `SriMessage` has nullable strings `identifier,message,additionalInfo,type`. Successful authorized fiscal strings are retained, without raw-response fields. Limits mirror upstream storage/parser: identifier 20, message/additionalInfo 2000, type 30, outcome 30, SRI status 60, 100 messages per attempt. The bare array order stays newest-first. These strings must never be copied into generic logs, audit detail or ProviderError; the next task encrypts and controls access to persisted explanations.
- `ArtifactKind`: `xml-unsigned|xml-signed|sri-authorization|xml-authorized|ride`. `ProviderArtifact`: `{bytes:Buffer,contentType:'application/xml'|'application/pdf',etag:string,sha256:string}`. ETag is preserved including quotes, and its digest must equal SHA-256 of the downloaded bytes before return. Invalid/missing/weak/mismatching ETags and wrong media types fail transiently with `INVALID_ARTIFACT`.

`ProviderError` extends `Error` and has constructor `(kind: ProviderErrorKind, code: string, metadata: {status?:number;retryAfterMs?:number} = {})`. `kind` is `'transient'|'data'|'configuration'`. Adapter-generated errors contain only a controlled code and numeric metadata; they have no cause, raw response, upstream detail, field messages, request headers or body. Error code text from upstream is accepted only through a fixed safe allowlist; unrecognized strings use a fixed fallback.

## HTTP behavior and boundaries

- Global URL must include one `/api/v1` suffix; supported proxy roots and an optional trailing slash are preserved/normalized. Invalid protocol, embedded user/password, query, fragment, missing prefix and duplicate adjacent prefix are rejected. Endpoints are constructed internally and IDs are validated UUIDs. Redirects are manually rejected with `REDIRECT_REJECTED`, so credentials cannot follow a Location header to another origin.
- Every call sends only `X-Api-Key` authentication, optional safe `X-Correlation-Id`, and JSON content type for POST. Invoice POST adds `Idempotency-Key`; there is no JWT/token exchange or Authorization header.
- GET uses the audited routes, customer/product creates require 201, and invoice create requires 202. Document/SRI detail and binary artifacts use their audited full paths under the configured prefix.
- Every request has a fifteen-second deadline covering response headers **and body consumption**. Transport failures are `transient/NETWORK_ERROR`; deadline expiration is `transient/TIMEOUT`.
- Bare arrays are the exact upstream option contract. If option envelopes are encountered, they are fully traversed. Customer/product pages use `{items,page,size,total}`, zero-based pages and requested size 100, honoring a valid server-declared first-page size. Exact-match searches return null only after complete traversal. Malformed, premature empty/partial pages and nonprogressing metadata fail rather than silently returning incomplete data. Bounds are 1000 requests and 100000 items per traversal; exceeding either throws a transient error, never a truncated successful list.
- JSON response body limit is 10 MiB, artifacts 20 MiB, error bodies 64 KiB. Overflow fails without persisting any body. Error-body parse failures still retain safe HTTP status classification.
- 401/403 -> configuration; 404 -> data/NOT_FOUND (including a pending artifact); 422 -> safe data code; 409 -> safe data conflict; 429 -> transient/RATE_LIMITED with Retry-After in milliseconds (seconds or HTTP date); 5xx -> transient/PROVIDER_UNAVAILABLE.
- A compatibility `409 IDEMPOTENCY_IN_PROGRESS` is transient. **The audited Java implementation currently does not emit it**: competing transactions serialize, and null document ID or hash mismatch both yield `IDEMPOTENCY_KEY_REUSED`. That actual reused-key code stays nonretryable `data`; the core must conservatively retain any ambiguous prior intent and must not create a new invoice/key merely because of this error.

## Webhook function

`verifyWebhookSignature(rawBody: Buffer, headers: WebhookHeaders, secret: string, now: Date = new Date()): boolean`, with `WebhookHeaders = Record<string,string|string[]|undefined>`.

The function decodes exactly the standard Base64 suffix of `whsec_` into the 32-byte key, authenticates `${webhook-id}.${webhook-timestamp}.` plus the original raw bytes using HMAC-SHA256, and uses constant-time digest comparison. Any valid `v1` member of a space-separated signature list is accepted. Header names are case insensitive, duplicate/missing security headers fail closed, and malformed/noncanonical Base64, changed/reserialized bodies, wrong literal-secret keys and timestamps beyond the receiver's five-minute past/future tolerance are rejected. Event UUID and timestamp structure are checked before HMAC. Deduplication and document reconciliation belong to core.

## Remaining integration responsibilities

No blockers in this task. Core must enforce immutable/correct fiscal snapshots, changed customer/product conflicts, permissions, encrypted SRI explanation persistence, cautious ambiguous idempotency handling, and mapping of future states. Webhook subscription management is intentionally absent: the API key cannot administer it. No claim of remote provider interoperability or live credentials is made; local controller source is the authority used for the executable contract tests.

## Review fix round 1 — I1 terminal-page completeness

Fix commit: `1cda589` (`fix(invoicing): reject truncated terminal provider pages`).

Verified the independent review's Important finding against `pages()`: the former completeness check only enforced full nonterminal pages or rejected an empty terminal page. A nonempty terminal page with fewer items than its declared remaining total could falsely resolve null, a partial option array, or even an exact match before completeness validation.

Seven local HTTP regressions were added first: customer, product and paged tax-rate options with truncated terminal page 0 (`size:100,total:2,items:1`) and page 1 (full first 100 items, then `size:100,total:150,items:1`), plus an exact customer match present on an incomplete terminal page. No remote calls, overflow-test scope expansion or broad API suite was involved.

RED command:

```powershell
npx jest --runInBand --runTestsByPath src/invoicing/provider/emite-facil.provider.spec.ts --testNamePattern 'truncated terminal'
```

Observed exit 1: **1 failed suite / 7 failed / 65 skipped / 72 total tests**. Customer/product lookups incorrectly resolved null; option lists resolved partial arrays; the exact-match case resolved the stored customer instead of rejecting.

The fix validates `items.length === Math.min(responseSize, total - page * responseSize)` before calling the visitor or deciding traversal has ended. Any mismatch returns the existing sanitized `transient/INCOMPLETE_PAGINATION` error.

GREEN with the same focused command: exit 0, **1 passed suite / 7 passed / 65 skipped / 72 total tests**. Then the full two provider suites were run once:

```powershell
npx jest --runInBand --runTestsByPath src/invoicing/provider/emite-facil.provider.spec.ts src/invoicing/provider/webhook-signature.spec.ts
```

Observed exit 0: **2 passed suites / 98 passed / 98 total tests**, including the existing real fifteen-second timeout. Prettier on the two changed files, focused ESLint and `git diff --check` also passed. Only the provider implementation and provider spec changed; response-overflow coverage remains deferred as the review's nonblocking suggestion.
