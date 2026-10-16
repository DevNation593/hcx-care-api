# Caja (B1) — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Perfiles fiscales separados del paciente, caja por sucursal con apertura, cierre y arqueo, órdenes con ítems de sesión y conceptos libres, pagos parciales y devoluciones, y la elegibilidad de facturación (RN-10), en la API y en la web, sin emitir todavía comprobantes (eso es B2).

**Architecture:** La API (NestJS + Prisma) agrega tres módulos: `billing-profiles`, `cash-registers` y `orders` (órdenes, ítems, pagos y elegibilidad). Las reglas viven en funciones puras (`tax-identification.ts`, `order-totals.ts`, `cash-count.ts`, `billing-eligibility.ts`); los servicios las invocan dentro de `runSerializableTransaction` y auditan cada comando con `recordBillingAudit`. La elegibilidad lee los hechos clínicos con `loadSessionFacts` de A, sin exponer datos clínicos. La web (Next.js) agrega la caja (`/cash`) y la orden (`/cash/orders/[id]`), los perfiles en la ficha del paciente y la casilla `billingGate` en el editor de tratamientos.

**Tech Stack:** NestJS 11, Prisma 6 (`Prisma.Decimal`), PostgreSQL, Jest + supertest; Next.js 14, React Query 5, Tailwind, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-15-cash-and-billing-design.md` (en `hcx-care-api`). Secciones de B1: «B1 — Modelo de datos», «B1 — Elegibilidad», «B1 — API», «Web» (todo menos Emitir, la pestaña Facturas y `/admin/billing`), «Manejo de errores» y «Pruebas» (partes de caja).

## Global Constraints

- Rama `feat/cash-and-billing` en `api/.worktrees/cash-and-billing` y `web/.worktrees/cash-and-billing`, creada desde `claude/compassionate-hopper-t6teqf`; nunca otra. Sin upstream: no se hace push sin pedirlo.
- Prefijo de rutas `/api/v1/tenants/:tenantId`; sección `@RequireSection('core.billing')` en los tres controladores nuevos.
- Rutas: `@Roles('MASTER')` + `@RequirePermission(<permiso>)`, la convención del repo para permisos concedibles (el `RolesGuard` deja pasar a quien lo tenga concedido).
- Permisos: `billing.view`, `billing.create`, `billing.adjust`, `cash.manage`, todos con `roles: ['MASTER']` y `grantable: ['PROFESIONAL', 'ASISTENTE']`.
- Errores con el formato existente `{ statusCode, code, message }`; los 422 de elegibilidad agregan `missing: string[]` e `items`.
- Códigos de `missing` exactos y en este orden: `FINALIZED_MEDICAL_FORM`, `SIGNED_APPLICABLE_CONSENT`, `CLINICAL_COMPLETION`, `SESSION_NOT_BILLABLE`, `BILLING_PROFILE`, `INVOICE_ITEMS`, `BALANCE_DUE`, `INVOICING_NOT_CONFIGURED` (este último nunca aparece en B1).
- Dinero `Decimal(10,2)`, tarifas `Decimal(5,2)`, cantidades `Decimal(12,6)`; cálculos con `Prisma.Decimal` y redondeo `ROUND_HALF_UP` a 2 decimales; nunca `number` para importes. En JSON, importes como cadena con 2 decimales.
- Toda hora de apertura, cierre, pago y devolución la pone el servidor.
- Tarifas admitidas en conceptos libres: 0, 5 y 15. Monto máximo de consumidor final: 50.00.
- Ningún endpoint de caja devuelve diagnósticos, notas, respuestas de ficha, fotos ni contenido de consentimientos; del paciente solo `id`, nombre e identificación.
- Textos de interfaz y mensajes de error en español; comentarios de código en inglés.
- Sin dependencias nuevas en ningún repo.
- Archivos existentes con CRLF: editarlos con la herramienta Edit, no con parches que asuman `\n`.
- `npm run lint` de la API está roto (T-15): verificar con `npx prettier --check` sobre los archivos tocados.
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Dos cajeros registran el último pago a la vez**: la suma nunca supera el total; uno recibe 201 y el otro `422 PAYMENT_EXCEEDS_BALANCE` (o `409 ORDER_VERSION_CONFLICT` si la transacción serializable choca). Prueba en Task 7.
2. **Dos aperturas simultáneas de la caja de una sucursal**: una sola caja `OPEN`; la segunda petición recibe `409 CASH_REGISTER_ALREADY_OPEN`, también cuando el choque lo detecta el índice único (P2002). Prueba en Task 5.
3. **La misma sesión agregada a dos órdenes a la vez**: el índice parcial deja una; la otra recibe `409 SESSION_ALREADY_IN_ORDER`. Al cancelar la orden, la sesión vuelve a estar libre. Prueba en Task 6.
4. **Sesión cancelada o con consentimiento revocado antes de iniciar después de cobrarla**: la orden queda pagada, la elegibilidad responde `SESSION_NOT_BILLABLE` para ese ítem y el pago se puede devolver. Prueba en Task 8.
5. **Identificación con espacios, guiones o minúsculas** (`' 1710034065 '`, `'ab-123'` como pasaporte): se normaliza (sin espacios; pasaporte en mayúsculas, solo alfanumérico) antes de validar y antes de comprobar duplicados, así que `'1710034065'` y `' 1710034065 '` chocan como `409 BILLING_PROFILE_DUPLICATE`. Prueba en Task 2 y Task 4.

---

## API (`hcx-care-api`, en `api/.worktrees/cash-and-billing`)

### Task 1: Esquema, migración, permisos y cableado

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261016000000_cash_and_billing/migration.sql`
- Modify: `src/prisma/prisma.service.ts` (`bindRlsDelegates`, `cleanDatabase`)
- Modify: `src/common/permissions/permission-catalog.ts`
- Test: `src/common/permissions/permissions.spec.ts`

**Interfaces:**
- Produces (Prisma):
  - enums `BillingProfileKind { PERSON COMPANY }`, `CashRegisterStatus { OPEN CLOSED }`, `OrderStatus { OPEN PAID INVOICED CANCELLED }`, `OrderItemKind { TREATMENT_SESSION FREE }`, `PaymentMethod { CASH DEBIT_CARD CREDIT_CARD TRANSFER OTHER }`, `PaymentStatus { RECORDED REFUNDED }`.
  - `TreatmentSessionStatus` += `BILLING_PENDING`, `BILLED`, `BILLING_FAILED`.
  - `AuditEntity` += `BILLING_PROFILE`, `ORDER`, `PAYMENT`, `CASH_REGISTER`, `INVOICE_REQUEST`.
  - models `BillingProfile`, `PatientBillingProfile`, `CashRegisterSession`, `Order`, `OrderItem`, `Payment` con los campos de la spec («B1 — Modelo de datos»); ids `cuid()`; `idType String` (código SRI de dos dígitos); `Order.number Int`, `Order.version Int @default(1)`.
  - `OrderItem.releasedAt DateTime?`: se fija al cancelar la orden; un ítem con `releasedAt` ya no ocupa su sesión.
  - uniques: `BillingProfile(tenantId, idType, idNumber)`, `PatientBillingProfile(patientId, billingProfileId)`, `Order(tenantId, number)`, `Payment(tenantId, idempotencyKey)`.
  - indexes: `(tenantId, legalName)` en `BillingProfile`; `(tenantId, branchId, status)` en `CashRegisterSession` y en `Order`; `(tenantId, createdAt)` en `Order`; `(orderId)` en `OrderItem` y `Payment`; `(cashRegisterSessionId)` y `(refundCashRegisterSessionId)` en `Payment`; `(treatmentSessionId)` y `(patientId)` en `OrderItem`.
  - FKs a `Tenant` con `onDelete: Cascade`; a `User`, `Branch`, `Patient`, `TreatmentSession`, `BillingProfile`, `CashRegisterSession` y `Order` con `onDelete: Restrict`, salvo `PatientBillingProfile` (Cascade a paciente y a perfil) y `OrderItem.orderId` (Cascade).
- Produces (SQL a mano en la migración, que Prisma no expresa):
  - `CREATE UNIQUE INDEX "CashRegisterSession_branch_open_key" ON "CashRegisterSession"("branchId") WHERE "status" = 'OPEN';`
  - `CREATE UNIQUE INDEX "OrderItem_live_session_key" ON "OrderItem"("treatmentSessionId") WHERE "treatmentSessionId" IS NOT NULL AND "releasedAt" IS NULL;`
  - `CREATE UNIQUE INDEX "PatientBillingProfile_default_key" ON "PatientBillingProfile"("patientId") WHERE "isDefault";`
- Produces (permisos): entradas nuevas `{ key: 'billing.adjust', group: 'Facturación', label: 'Aplicar descuentos, conceptos libres y devoluciones', roles: ['MASTER'], grantable: ['PROFESIONAL', 'ASISTENTE'] }` y `{ key: 'cash.manage', group: 'Caja', label: 'Abrir y cerrar la caja', roles: ['MASTER'], grantable: ['PROFESIONAL', 'ASISTENTE'] }`; `billing.view` y `billing.create` pasan a `roles: ['MASTER']`, `grantable: ['PROFESIONAL', 'ASISTENTE']`.

- [ ] **Step 1: Write the failing permission tests** in `permissions.spec.ts`:
  - `rolePermissions('MASTER')` contiene los cuatro; `rolePermissions('PROFESIONAL')` y `rolePermissions('ASISTENTE')` no contienen ninguno.
  - `grantablePermissions('PROFESIONAL')` y `grantablePermissions('ASISTENTE')` contienen los cuatro.
  - Actualizar las aserciones existentes que esperan `billing.view`/`billing.create` en PROFESIONAL.
- [ ] **Step 2: Run** `npx jest src/common/permissions` — Expected: FAIL.
- [ ] **Step 3: Edit the catalog.** Run again — Expected: PASS. Run `npx jest src/billing src/users src/common` and fix every test that assumed a PROFESIONAL bills by default (they now need a grant) — Expected: PASS.
- [ ] **Step 4: Edit `schema.prisma`** and create the migration against a disposable database: `DATABASE_URL=<scratch> npx prisma migrate dev --name cash_and_billing --create-only`, rename the folder to `20261016000000_cash_and_billing` and append the three partial indexes. Additive only (no `DROP`, no `ALTER ... TYPE`); enum values with `ALTER TYPE ... ADD VALUE`.
- [ ] **Step 5: Wire Prisma.** Add delegates `billingProfile`, `patientBillingProfile`, `cashRegisterSession`, `order`, `orderItem`, `payment` to `bindRlsDelegates`. In `cleanDatabase`, after `auditLog` and before `treatmentSession`: `payment`, `orderItem`, `order`, `cashRegisterSession`, `patientBillingProfile`, `billingProfile`.
- [ ] **Step 6: Verify** `npx prisma validate && DATABASE_URL=<scratch> npx prisma migrate reset --force --skip-seed && npx prisma migrate diff --from-url <scratch> --to-schema-datamodel prisma/schema.prisma --script` — Expected: the only statements, if any, drop partial indexes created by hand (the three new ones and the ones that already existed, such as `User_tenantId_master_key`), which Prisma does not model; `npx tsc --noEmit -p tsconfig.json` and `npx jest src/common src/app.module.spec.ts src/app.wiring.spec.ts` PASS.
- [ ] **Step 7: Commit** `feat(api): add billing profiles, cash registers, orders and payments to the schema`.

### Task 2: Reglas puras — identificación, totales y arqueo

**Files:**
- Create: `src/billing-profiles/tax-identification.ts`, `src/billing-profiles/tax-identification.spec.ts`
- Create: `src/orders/order-totals.ts`, `src/orders/order-totals.spec.ts`
- Create: `src/cash-registers/cash-count.ts`, `src/cash-registers/cash-count.spec.ts`

**Interfaces:**
- Consumes: `PaymentMethod` from `@prisma/client` (Task 1).
- Produces:
  ```ts
  // tax-identification.ts
  export type SriIdType = '04' | '05' | '06' | '07';
  export const FINAL_CONSUMER_ID = '9999999999999';
  export const FINAL_CONSUMER_NAME = 'CONSUMIDOR FINAL';
  export function normalizeIdNumber(idType: SriIdType, raw: string): string;
  export function isValidCedula(value: string): boolean;
  export function assertValidTaxIdentification(idType: string, idNumber: string, legalName: string): void;
  // throws UnprocessableEntityException { statusCode: 422, code: 'BILLING_PROFILE_INVALID', message }

  // order-totals.ts
  export interface LineInput { quantity: Prisma.Decimal.Value; unitPrice: Prisma.Decimal.Value; discount: Prisma.Decimal.Value; taxRatePercent: Prisma.Decimal.Value }
  export interface LineTotals { lineSubtotal: Prisma.Decimal; lineTax: Prisma.Decimal }
  export interface OrderTotals { lines: LineTotals[]; subtotal: Prisma.Decimal; discountTotal: Prisma.Decimal; taxTotal: Prisma.Decimal; total: Prisma.Decimal }
  export function computeOrderTotals(lines: LineInput[]): OrderTotals;
  // throws UnprocessableEntityException { statusCode: 422, code: 'ORDER_LINE_INVALID', message } when quantity <= 0, unitPrice < 0, discount < 0 or discount > quantity × unitPrice
  export const SUPPORTED_FREE_TAX_RATES: readonly number[]; // [0, 5, 15]

  // cash-count.ts
  export interface CashMovement { method: PaymentMethod; amount: Prisma.Decimal.Value }
  export interface CashCount {
    expectedCash: Prisma.Decimal;
    byMethod: Record<PaymentMethod, { received: Prisma.Decimal; refunded: Prisma.Decimal }>;
  }
  export function computeCashCount(openingCash: Prisma.Decimal.Value, received: CashMovement[], refunded: CashMovement[]): CashCount;
  ```

Rules the tests pin:
- `normalizeIdNumber`: quita espacios y guiones; en `06` además pasa a mayúsculas.
- `isValidCedula`: 10 dígitos, provincia (dos primeros) 01–24 o 30, tercer dígito 0–5, verificador módulo 10 (coeficientes 2,1,2,1,2,1,2,1,2 sobre los 9 primeros; un producto mayor que 9 resta 9; verificador `(10 − suma % 10) % 10`).
- `assertValidTaxIdentification`: `05` → `isValidCedula`; `04` → 13 dígitos terminados en `001`, y si el tercer dígito es 0–5 los 10 primeros son cédula válida; tercer dígito 6 o 9 solo formato; otro tercer dígito, inválido; `06` → `^[A-Z0-9]{3,20}$`; `07` → número `9999999999999` y nombre `CONSUMIDOR FINAL` (sin distinguir mayúsculas); `9999999999999` con otro tipo, inválido; otro `idType`, inválido.
- `computeOrderTotals`: `lineSubtotal = round2(quantity × unitPrice − discount)`; por tarifa, `tax = round2(Σ lineSubtotal × rate / 100)`; `lineTax` se reparte por mayor resto: cada línea recibe `floor` a centavos de `lineSubtotal × rate / 100` y los centavos que faltan para el impuesto de la tarifa van, uno por línea, a los mayores restos (empate: la línea anterior), de modo que ninguna línea queda negativa (decisión R4 de la ejecución); `subtotal = Σ lineSubtotal`; `discountTotal = Σ discount`; `total = subtotal + taxTotal`. Lista vacía → todo `0.00`.
- `computeCashCount`: `expectedCash = openingCash + Σ received CASH − Σ refunded CASH`; `byMethod` trae las cinco formas, en cero si no hubo movimientos.

- [ ] **Step 1: Write failing tests.**
  - `tax-identification.spec.ts`: válidos `('05','1710034065')`, `('04','1710034065001')`, `('04','1790012345001')`, `('04','1760001550001')`, `('06','AB123')`, `('07','9999999999999','Consumidor Final')`; inválidos con `code: 'BILLING_PROFILE_INVALID'`: `('05','1710034066')` (verificador), `('05','2510034065')` (provincia 25), `('05','1760034065')` (tercer dígito 6), `('05','171003406')` (9 dígitos), `('04','1710034065002')`, `('04','1710034066001')`, `('04','1780012345001')` (tercer dígito 8), `('04','9999999999999')`, `('06','A*1')`, `('06','AB')`, `('07','9999999999999','Ana')`, `('03','1710034065')`. `normalizeIdNumber('05',' 1710034065 ')` → `'1710034065'`; `normalizeIdNumber('06','ab-123')` → `'AB123'`.
  - `order-totals.spec.ts`: una línea `2 × 10.00`, descuento `0`, 15 % → subtotal `20.00`, IVA `3.00`, total `23.00`; tres líneas `1 × 0.10` al 15 % → IVA `0.05` (sobre la suma, no `0.06`), `lineTax` `['0.02','0.02','0.01']`, total `0.35`; `2 × 10.00` con descuento `1.50` al 15 % y `1 × 5.00` al 0 % → subtotal `23.50`, descuento `1.50`, IVA `2.78` (`18.50 × 0.15 = 2.775` → `2.78`), total `26.28`; descuento mayor que el bruto → `ORDER_LINE_INVALID`; cantidad `0` → `ORDER_LINE_INVALID`; lista vacía → total `0.00`.
  - `cash-count.spec.ts`: apertura `20.00`, recibidos `CASH 15.00`, `CASH 5.00`, `CREDIT_CARD 30.00`, devuelto `CASH 5.00` → `expectedCash` `35.00`, `byMethod.CASH` `{ received: '20.00', refunded: '5.00' }`, `byMethod.CREDIT_CARD.received` `'30.00'`, `byMethod.TRANSFER` en cero.
- [ ] **Step 2: Run** `npx jest src/billing-profiles src/orders src/cash-registers` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement the three files.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): validate tax identifications and compute order totals and cash counts`.

### Task 3: Evaluador de elegibilidad, `billingGate` y estados de facturación de la sesión

**Files:**
- Create: `src/orders/billing-eligibility.ts`, `src/orders/billing-eligibility.spec.ts`
- Modify: `src/treatments/treatment-requirements.ts`, `src/treatments/treatment-requirements.spec.ts`
- Modify: `src/treatment-sessions/session-state.ts`, `src/treatment-sessions/session-state.spec.ts`
- Modify: `src/treatment-sessions/treatment-sessions.service.ts` (`compliance`), `src/treatment-sessions/treatment-sessions.service.spec.ts`

**Interfaces:**
- Consumes: `TreatmentRequirements` (A), `TreatmentSessionStatus` (Task 1).
- Produces:
  ```ts
  // treatment-requirements.ts
  export interface TreatmentRequirements { /* A's four keys */ billingGate: { requireClinicalCompletion: boolean } }
  // DEFAULT_REQUIREMENTS.billingGate = { requireClinicalCompletion: true }; unknown keys inside billingGate rejected like A's

  // session-state.ts
  export const BILLING_SESSION_STATUSES: readonly TreatmentSessionStatus[]; // BILLING_PENDING, BILLED, BILLING_FAILED
  // TERMINAL_SESSION_STATUSES += the three; assertCommandAllowed throws for BILLING_PENDING and BILLED:
  // ConflictException { statusCode: 409, code: 'TREATMENT_SESSION_BILLED', message: 'La atención ya está facturada o en facturación.', status, command }

  // billing-eligibility.ts
  export type ClinicalBillingCode = 'FINALIZED_MEDICAL_FORM' | 'SIGNED_APPLICABLE_CONSENT' | 'CLINICAL_COMPLETION' | 'SESSION_NOT_BILLABLE';
  export type CashBillingCode = 'BILLING_PROFILE' | 'INVOICE_ITEMS' | 'BALANCE_DUE' | 'INVOICING_NOT_CONFIGURED';
  export type BillingCode = ClinicalBillingCode | CashBillingCode;
  export const BILLING_CODE_ORDER: readonly BillingCode[]; // the order of the Global Constraints
  export const FINAL_CONSUMER_LIMIT: Prisma.Decimal; // 50.00
  export interface SessionBillingFacts {
    itemId: string; patientName: string; status: TreatmentSessionStatus; policy: TreatmentRequirements;
    hasForm: boolean; hasApplicableConsent: boolean; completed: boolean;
  }
  export interface OrderBillingFacts {
    sessions: SessionBillingFacts[]; itemCount: number; total: Prisma.Decimal; paidTotal: Prisma.Decimal;
    profile: { isActive: boolean; idType: string } | null;
    invoicingConfigured: boolean | null; // null: not evaluated (B1)
  }
  export interface BillingEligibility {
    eligible: boolean; missing: BillingCode[];
    items: { itemId: string; patientName: string; codes: ClinicalBillingCode[] }[];
  }
  export function evaluateBillingEligibility(facts: OrderBillingFacts): BillingEligibility;
  export function billingBlocked(result: BillingEligibility): UnprocessableEntityException;
  // TREATMENT_DOCUMENTATION_INCOMPLETE ('La orden incluye atenciones sin la documentación obligatoria.') when any clinical code is missing, else ORDER_NOT_BILLABLE ('La orden aún no se puede facturar.'); both carry missing and items
  ```

Rules: per session — `SESSION_NOT_BILLABLE` if status is `CANCELLED`, `NO_SHOW`, `CONSENT_REFUSED`, `CONSENT_REVOKED`, `BILLING_PENDING` or `BILLED` (and then no other code for that item); else `FINALIZED_MEDICAL_FORM` if `policy.medicalForm.required && !hasForm`; `SIGNED_APPLICABLE_CONSENT` if `policy.informedConsent.required && !hasApplicableConsent`; `CLINICAL_COMPLETION` if `policy.billingGate.requireClinicalCompletion && !completed`. Order — `BILLING_PROFILE` if `profile` is null, inactive, or `idType === '07'` with `total > 50.00`; `INVOICE_ITEMS` if `itemCount === 0` or `total` is zero; `BALANCE_DUE` if `paidTotal < total`; `INVOICING_NOT_CONFIGURED` if `invoicingConfigured === false`. `items` lists only sessions with codes.

- [ ] **Step 1: Write failing tests.**
  - `billing-eligibility.spec.ts`: todo cumplido → `{ eligible: true, missing: [], items: [] }`; cada código solo; dos sesiones de dos pacientes, una sin ficha y otra sin firma → `missing` `['FINALIZED_MEDICAL_FORM','SIGNED_APPLICABLE_CONSENT']` e `items` con un código cada una; `billingGate.requireClinicalCompletion: false` con `completed: false` → sin `CLINICAL_COMPLETION`; sesión `CANCELLED` sin ficha → solo `SESSION_NOT_BILLABLE`; sesión `BILLING_FAILED` completa → elegible; perfil `07` con total `50.00` → elegible, con `50.01` → `BILLING_PROFILE`; `invoicingConfigured: null` → nunca `INVOICING_NOT_CONFIGURED`; `billingBlocked` elige `TREATMENT_DOCUMENTATION_INCOMPLETE` con `['BALANCE_DUE','CLINICAL_COMPLETION']` (y `missing` en el orden canónico) y `ORDER_NOT_BILLABLE` con `['BALANCE_DUE']`.
  - `treatment-requirements.spec.ts`: `parseTreatmentRequirements({}).billingGate` es `{ requireClinicalCompletion: true }`; `{ billingGate: { requireClinicalCompletion: false } }` se respeta; `{ billingGate: { other: 1 } }` y `{ billingGate: { requireClinicalCompletion: 'no' } }` → `TREATMENT_REQUIREMENTS_INVALID`.
  - `session-state.spec.ts`: `allowedCommands` de los tres estados nuevos es `[]`; `assertCommandAllowed('BILLED','CANCEL',p)` y `('BILLING_PENDING','SAVE_FORM',p)` lanzan `TREATMENT_SESSION_BILLED`; `('BILLING_FAILED','CANCEL',p)` lanza `TREATMENT_SESSION_INVALID_TRANSITION`; `TERMINAL_SESSION_STATUSES` incluye los tres.
  - `treatment-sessions.service.spec.ts`: `compliance` de una sesión `BILLED` responde `{ status: 'BILLED', missing: [] }` sin leer hechos.
- [ ] **Step 2: Run** `npx jest src/orders/billing-eligibility src/treatments src/treatment-sessions` — Expected: FAIL.
- [ ] **Step 3: Implement.** In `compliance`, return early for `CLINICAL_COMPLETE` and every `BILLING_SESSION_STATUSES` status.
- [ ] **Step 4: Run** the same command and the whole `npx jest src/treatment-sessions src/treatments src/specialty-records` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): billing eligibility, the billing gate of a treatment and the billing states of a session`.

### Task 4: Perfiles fiscales y su vínculo con pacientes

**Files:**
- Create: `src/common/audit/billing-audit.ts`
- Create: `src/billing-profiles/billing-profiles.module.ts`, `billing-profiles.controller.ts`, `billing-profiles.service.ts`, `billing-profiles.service.spec.ts`, `dto/billing-profile.dto.ts`
- Modify: `src/app.module.ts`, `src/app.wiring.spec.ts`

**Interfaces:**
- Consumes: `assertValidTaxIdentification`, `normalizeIdNumber` (Task 2); `runSerializableTransaction`.
- Produces:
  ```ts
  // billing-audit.ts
  export type BillingAuditEntity = 'BILLING_PROFILE' | 'ORDER' | 'PAYMENT' | 'CASH_REGISTER' | 'INVOICE_REQUEST';
  export interface BillingAuditInput { tenantId: string; actorId: string; action: AuditAction; entity: BillingAuditEntity; entityId: string; changes?: unknown; reason?: string }
  export function recordBillingAudit(client: Pick<Prisma.TransactionClient, 'auditLog'>, input: BillingAuditInput): Promise<void>;

  // dto/billing-profile.dto.ts
  export class CreateBillingProfileDto { kind: BillingProfileKind; idType: '04'|'05'|'06'|'07'; idNumber: string; legalName: string; email?: string; address?: string; phone?: string }
  export class UpdateBillingProfileDto { legalName?; email?; address?; phone?; isActive?: boolean }
  export class LinkBillingProfileDto { billingProfileId: string; isDefault?: boolean }
  export class ListBillingProfilesQuery { q?: string; active?: 'true'|'false'; page?: number; pageSize?: number }

  // billing-profiles.service.ts
  export class BillingProfilesService {
    list(tenantId: string, query: ListBillingProfilesQuery): Promise<{ items: BillingProfile[]; total: number; page: number; pageSize: number }>;
    create(tenantId: string, actorId: string, dto: CreateBillingProfileDto): Promise<BillingProfile>;
    get(tenantId: string, id: string): Promise<BillingProfile>;
    update(tenantId: string, actorId: string, id: string, dto: UpdateBillingProfileDto): Promise<BillingProfile>;
    listForPatient(tenantId: string, patientId: string): Promise<(BillingProfile & { isDefault: boolean })[]>;
    linkToPatient(tenantId: string, actorId: string, patientId: string, dto: LinkBillingProfileDto): Promise<(BillingProfile & { isDefault: boolean })[]>;
    unlinkFromPatient(tenantId: string, actorId: string, patientId: string, profileId: string): Promise<void>;
  }
  ```
- Routes (spec «Perfiles fiscales»): lectura `billing.view`, escritura `billing.create`.

Rules: `legalName` 1–300 y `email` válido (obligatorio salvo `07`) en el DTO; `idNumber` normalizado antes de validar y de buscar duplicados; duplicado → `409 BILLING_PROFILE_DUPLICATE` (también si lo detecta P2002); `pageSize` 1–100, por defecto 20; `q` busca `legalName` por `contains` sin distinguir mayúsculas o `idNumber` por `startsWith`; `isDefault: true` quita el predeterminado anterior en la misma transacción; vincular un perfil inactivo → `409 BILLING_PROFILE_INACTIVE`; paciente o perfil de otro tenant → `404 PATIENT_NOT_FOUND` / `404 BILLING_PROFILE_NOT_FOUND`. Cada escritura llama a `recordBillingAudit` (`CREATE`/`UPDATE`, entidad `BILLING_PROFILE`) con `changes` sin la identificación completa (solo `idType`).

- [ ] **Step 1: Write failing tests** in `billing-profiles.service.spec.ts` (Prisma mocked as in `treatments.service.spec.ts`): crea con identificación normalizada; `' 1710034065 '` contra uno existente `'1710034065'` → `BILLING_PROFILE_DUPLICATE`; cédula inválida → `BILLING_PROFILE_INVALID`; `update` no acepta `idNumber` (el DTO no lo tiene y el servicio no lo escribe); `linkToPatient` con `isDefault` deja un solo predeterminado; perfil de otro tenant → 404; cada escritura escribe una fila de auditoría sin `idNumber`.
- [ ] **Step 2: Run** `npx jest src/billing-profiles` — Expected: FAIL.
- [ ] **Step 3: Implement** the audit helper, DTOs (class-validator, como `treatment.dto.ts`), service, controller and module; register the module in `app.module.ts` and in `app.wiring.spec.ts`.
- [ ] **Step 4: Run** `npx jest src/billing-profiles src/app.module.spec.ts src/app.wiring.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): billing profiles apart from the patient, linkable as the patient's default`.

### Task 5: Caja por sucursal

**Files:**
- Create: `src/cash-registers/cash-registers.module.ts`, `cash-registers.controller.ts`, `cash-registers.service.ts`, `cash-registers.service.spec.ts`, `dto/cash-register.dto.ts`
- Modify: `src/app.module.ts`, `src/app.wiring.spec.ts`

**Interfaces:**
- Consumes: `computeCashCount` (Task 2), `recordBillingAudit` (Task 4).
- Produces:
  ```ts
  export class OpenCashRegisterDto { branchId: string; openingCash: string } // decimal string, >= 0, 2 decimals
  export class CloseCashRegisterDto { countedCash: string; closingNote?: string } // note 1–500
  export interface CashRegisterDetail extends CashRegisterSession { summary: CashCount }
  export class CashRegistersService {
    list(tenantId: string, query: { branchId?: string; status?: CashRegisterStatus; page?: number; pageSize?: number }): Promise<{ items: CashRegisterSession[]; total: number; page: number; pageSize: number }>;
    open(tenantId: string, actorId: string, dto: OpenCashRegisterDto): Promise<CashRegisterDetail>;
    get(tenantId: string, id: string): Promise<CashRegisterDetail>;
    close(tenantId: string, actorId: string, id: string, dto: CloseCashRegisterDto): Promise<CashRegisterDetail>;
  }
  export function findOpenCashRegister(tx: Prisma.TransactionClient, tenantId: string, branchId: string): Promise<CashRegisterSession>;
  // throws ConflictException { statusCode: 409, code: 'CASH_REGISTER_CLOSED', message: 'La caja de la sucursal está cerrada.' }
  ```
- Routes (spec «Caja»): `GET` con `billing.view`; `open` y `close` con `cash.manage`.

Rules: la sucursal debe ser del tenant y estar activa (`404 BRANCH_NOT_FOUND`); otra caja `OPEN` en la sucursal o P2002 del índice parcial → `409 CASH_REGISTER_ALREADY_OPEN`; cerrar una cerrada → `409 CASH_REGISTER_CLOSED`; al cerrar, `summary` se calcula con los pagos cuyo `cashRegisterSessionId` es esta caja (recibidos) y cuyo `refundCashRegisterSessionId` es esta caja (devueltos); `difference = countedCash − expectedCash`; diferencia distinta de cero sin nota → `422 CASH_CLOSING_NOTE_REQUIRED`; se guardan `expectedCash`, `countedCash`, `difference`, `closedById`, `closedAt`. Auditoría `CREATE` al abrir y `UPDATE` al cerrar (entidad `CASH_REGISTER`), con la diferencia en `changes`.

- [ ] **Step 1: Write failing tests** in `cash-registers.service.spec.ts`: abre; segunda apertura → `CASH_REGISTER_ALREADY_OPEN`; un P2002 de `create` se traduce al mismo 409; cierra con diferencia `0.00` sin nota; cierra con diferencia `-2.00` sin nota → `CASH_CLOSING_NOTE_REQUIRED`, con nota → guarda `difference` `-2.00`; cerrar una cerrada → `CASH_REGISTER_CLOSED`; sucursal de otro tenant → `BRANCH_NOT_FOUND`; `findOpenCashRegister` sin caja → `CASH_REGISTER_CLOSED`.
- [ ] **Step 2: Run** `npx jest src/cash-registers` — Expected: FAIL.
- [ ] **Step 3: Implement** inside `runSerializableTransaction`; register the module.
- [ ] **Step 4: Run** `npx jest src/cash-registers src/app.wiring.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): one open cash register per branch, closed with a cash count`.

### Task 6: Órdenes e ítems

**Files:**
- Create: `src/orders/orders.module.ts`, `orders.controller.ts`, `orders.service.ts`, `orders.service.spec.ts`, `dto/order.dto.ts`, `order-view.ts`
- Modify: `src/app.module.ts`, `src/app.wiring.spec.ts`

**Interfaces:**
- Consumes: `computeOrderTotals`, `SUPPORTED_FREE_TAX_RATES` (Task 2); `parseTreatmentRequirements` (A); `PermissionChecker` (`src/common/permissions/permission-checker.service.ts`); `recordBillingAudit` (Task 4).
- Produces:
  ```ts
  // dto/order.dto.ts
  export class CreateOrderDto { branchId?: string; treatmentSessionIds?: string[]; billingProfileId?: string }
  export class AddOrderItemDto { version: number; kind: OrderItemKind; treatmentSessionId?: string; description?: string; quantity?: string; unitPrice?: string; taxRatePercent?: number; patientId?: string; discount?: string }
  export class UpdateOrderItemDto { version: number; discount: string }
  export class SetOrderBillingProfileDto { version: number; billingProfileId: string }
  export class CancelOrderDto { version: number; reason: string } // 1–500
  export class ListOrdersQuery { status?: OrderStatus; branchId?: string; q?: string; page?: number; pageSize?: number }
  export class BillableSessionsQuery { branchId?: string; patientId?: string }

  // order-view.ts — the only shape the API returns for an order
  export interface OrderView {
    id: string; number: number; status: OrderStatus; branchId: string; version: number;
    billingProfile: { id: string; kind: BillingProfileKind; idType: string; idNumber: string; legalName: string; email: string | null } | null;
    subtotal: string; discountTotal: string; taxTotal: string; total: string; paidTotal: string; balance: string;
    items: { id: string; kind: OrderItemKind; treatmentSessionId: string | null; patient: { id: string; firstName: string; lastName: string } | null;
             description: string; quantity: string; unitPrice: string; discount: string; taxRatePercent: string; lineSubtotal: string; lineTax: string }[];
    payments: { id: string; method: PaymentMethod; amount: string; reference: string | null; status: PaymentStatus; receivedAt: string; receivedBy: { id: string; firstName: string; lastName: string }; refundedAt: string | null; refundReason: string | null }[];
    createdAt: string;
  }
  export const orderInclude; // items (with patient firstName/lastName), payments (with receivedBy), billingProfile — `satisfies Prisma.OrderInclude`
  export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
  export function toOrderView(order: OrderWithRelations): OrderView;

  export class OrdersService {
    list(tenantId: string, query: ListOrdersQuery): Promise<{ items: OrderView[]; total: number; page: number; pageSize: number }>;
    create(tenantId: string, actor: AuthUser, dto: CreateOrderDto): Promise<OrderView>;
    get(tenantId: string, id: string): Promise<OrderView>;
    addItem(tenantId: string, actor: AuthUser, orderId: string, dto: AddOrderItemDto): Promise<OrderView>;
    removeItem(tenantId: string, actorId: string, orderId: string, itemId: string, version: number): Promise<OrderView>;
    updateItemDiscount(tenantId: string, actorId: string, orderId: string, itemId: string, dto: UpdateOrderItemDto): Promise<OrderView>;
    setBillingProfile(tenantId: string, actorId: string, orderId: string, dto: SetOrderBillingProfileDto): Promise<OrderView>;
    cancel(tenantId: string, actorId: string, orderId: string, dto: CancelOrderDto): Promise<OrderView>;
  }
  // used by every write and by Task 7:
  export function loadOrderForWrite(tx: Prisma.TransactionClient, tenantId: string, orderId: string, version?: number): Promise<OrderWithRelations>;
  // 404 ORDER_NOT_FOUND; 409 ORDER_VERSION_CONFLICT when version is given and differs
  export function saveTotals(tx: Prisma.TransactionClient, order: OrderWithRelations): Promise<void>; // recomputes lines and totals, increments version
  ```
- Routes (spec «Órdenes y pagos», sin pagos, elegibilidad ni sesiones facturables): lectura `billing.view`; `POST /orders`, items, `billing-profile`, `cancel` con `billing.create`; `PATCH /orders/:id/items/:itemId` con `billing.adjust`.

Rules:
- `create`: con `treatmentSessionIds`, todas del tenant, con la misma `branchId` (o sin sucursal, y entonces `branchId` obligatorio en el DTO) → `422 ORDER_BRANCH_MISMATCH` si difieren; cada sesión pasa por las reglas de ítem de sesión; sin `billingProfileId` y con sesiones de un solo paciente, toma su perfil predeterminado si existe y está activo. `number = MAX(number) + 1` del tenant dentro de la transacción serializable.
- Ítem de sesión: sesión del tenant (`404 TREATMENT_SESSION_NOT_FOUND`); estado `CANCELLED`, `NO_SHOW`, `CONSENT_REFUSED`, `CONSENT_REVOKED`, `BILLING_PENDING` o `BILLED`, o sucursal distinta de la de la orden → `409 TREATMENT_SESSION_NOT_BILLABLE`; ya en un ítem con `releasedAt` nulo, o P2002 de `OrderItem_live_session_key` → `409 SESSION_ALREADY_IN_ORDER`. Copia `description` = nombre del tratamiento, `quantity` 1, `unitPrice` y `taxRatePercent` de la `TreatmentVersion`, `discount` 0, `patientId` de la sesión.
- Ítem `FREE` y todo `discount` distinto de 0: `permissionChecker.assertAllowed(actor, 'billing.adjust')`; tarifa fuera de `SUPPORTED_FREE_TAX_RATES` → `422 TAX_RATE_UNSUPPORTED`; `patientId`, si viene, del tenant.
- Ítems y descuentos: orden `OPEN` y sin pagos `RECORDED` → si no, `409 ORDER_NOT_EDITABLE`. Receptor: orden `OPEN` o `PAID`, perfil activo del tenant (`409 BILLING_PROFILE_INACTIVE`).
- `cancel`: con pagos `RECORDED` → `409 ORDER_HAS_PAYMENTS`; fija `cancelledAt`, `cancelledById`, `cancellationReason` y `releasedAt` en todos sus ítems.
- Cada escritura recalcula con `saveTotals` y audita (`ORDER`, `CREATE`/`UPDATE`/`DELETE` del ítem como `UPDATE` de la orden con el ítem en `changes`).
- [ ] **Step 1: Write failing tests** in `orders.service.spec.ts`: crea desde dos sesiones de dos pacientes con folio consecutivo y sin receptor automático; crea desde una sesión de un paciente con perfil predeterminado → lo toma; sesiones de sucursales distintas → `ORDER_BRANCH_MISMATCH`; sesión `NO_SHOW` → `TREATMENT_SESSION_NOT_BILLABLE`; sesión ya en otra orden viva → `SESSION_ALREADY_IN_ORDER` (y P2002 traducido igual); tras cancelar esa otra orden, se puede agregar; concepto libre sin `billing.adjust` (ASISTENTE con solo `billing.create`) → 403 `PERMISSION_DENIED`; tarifa 12 → `TAX_RATE_UNSUPPORTED`; agregar ítem con un pago `RECORDED` → `ORDER_NOT_EDITABLE`; `version` desactualizada → `ORDER_VERSION_CONFLICT`; cancelar con pago → `ORDER_HAS_PAYMENTS`; los totales guardados coinciden con `computeOrderTotals`; `toOrderView` no expone nada de la sesión salvo su id.
- [ ] **Step 2: Run** `npx jest src/orders/orders.service` — Expected: FAIL.
- [ ] **Step 3: Implement** DTOs, `order-view.ts`, service, controller and module; register the module.
- [ ] **Step 4: Run** `npx jest src/orders src/app.wiring.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): orders with session and free items, totals computed by the server`.

### Task 7: Pagos y devoluciones

**Files:**
- Create: `src/orders/payments.service.ts`, `src/orders/payments.service.spec.ts`, `src/orders/dto/payment.dto.ts`
- Modify: `src/orders/orders.controller.ts`, `src/orders/orders.module.ts`

**Interfaces:**
- Consumes: `findOpenCashRegister` (Task 5); `loadOrderForWrite`, `toOrderView` (Task 6); `recordBillingAudit` (Task 4).
- Produces:
  ```ts
  export class RecordPaymentDto { method: PaymentMethod; amount: string; reference?: string } // amount > 0, 2 decimals; reference <= 100
  export class RefundPaymentDto { reason: string } // 1–500
  export class PaymentsService {
    record(tenantId: string, actorId: string, orderId: string, dto: RecordPaymentDto, idempotencyKey?: string): Promise<OrderView>;
    refund(tenantId: string, actorId: string, paymentId: string, dto: RefundPaymentDto): Promise<OrderView>;
  }
  ```
- Routes: `POST /orders/:id/payments` (`billing.create`, cabecera opcional `Idempotency-Key`, hasta 100 caracteres `[A-Za-z0-9._:-]`, si no `400 IDEMPOTENCY_KEY_INVALID`) → 201; `POST /payments/:id/refund` (`billing.adjust`) → 200.

Rules: `record` en transacción serializable; con `Idempotency-Key` existente: mismo `orderId`, `method`, `amount` y `reference` → devuelve la orden sin crear nada; distinto → `409 IDEMPOTENCY_KEY_REUSED`. Orden `OPEN` (si no, `409 ORDER_NOT_EDITABLE`); caja con `findOpenCashRegister` de la sucursal de la orden; `amount > total − paidTotal` → `422 PAYMENT_EXCEEDS_BALANCE`; actualiza `paidTotal`, pasa a `PAID` con saldo cero e incrementa `version`. `refund`: pago del tenant (`404 PAYMENT_NOT_FOUND`), `RECORDED`, orden `OPEN` o `PAID` (si no, o si ya está `REFUNDED`, `409 PAYMENT_NOT_REFUNDABLE`; B2 agrega la condición de solicitud viva); la caja abierta de la sucursal de la orden recibe la devolución (`refundCashRegisterSessionId`); `paidTotal` baja y una orden `PAID` vuelve a `OPEN`. Auditoría `PAYMENT` `CREATE` y `UPDATE` (con `reason`).

- [ ] **Step 1: Write failing tests** in `payments.service.spec.ts`: dos abonos `10.00` + `13.00` sobre `23.00` → `PAID`, `balance` `0.00`; abono de `23.01` → `PAYMENT_EXCEEDS_BALANCE`; sin caja abierta → `CASH_REGISTER_CLOSED`; misma clave y mismo cuerpo → un solo pago; misma clave con otro monto → `IDEMPOTENCY_KEY_REUSED`; pagar una orden `PAID` → `ORDER_NOT_EDITABLE`; devolver deja la orden `OPEN` con `paidTotal` reducido y el pago `REFUNDED` con la caja de la devolución; devolver dos veces → `PAYMENT_NOT_REFUNDABLE`; orden `CANCELLED` → `PAYMENT_NOT_REFUNDABLE`.
- [ ] **Step 2: Run** `npx jest src/orders/payments.service` — Expected: FAIL.
- [ ] **Step 3: Implement** service, DTOs and the two routes.
- [ ] **Step 4: Run** `npx jest src/orders` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): partial payments into the open cash register, and refunds before invoicing`.

### Task 8: Elegibilidad de una orden y sesiones por cobrar

**Files:**
- Create: `src/orders/eligibility-facts.ts`, `src/orders/eligibility-facts.spec.ts`
- Modify: `src/orders/orders.service.ts` (`eligibility`, `billableSessions`), `src/orders/orders.controller.ts`, `src/orders/orders.service.spec.ts`

**Interfaces:**
- Consumes: `loadSessionFacts` (A, `src/treatment-sessions/session-facts.ts`), `parseTreatmentRequirements` (A + Task 3), `evaluateBillingEligibility` (Task 3).
- Produces:
  ```ts
  export function loadSessionBillingFacts(tx: Prisma.TransactionClient, session: TreatmentSession & { treatmentVersion: TreatmentVersion; patient: Pick<Patient, 'firstName' | 'lastName'> }, itemId: string, now: Date): Promise<SessionBillingFacts>;
  export function loadOrderBillingFacts(tx: Prisma.TransactionClient, tenantId: string, orderId: string, now: Date): Promise<OrderBillingFacts>; // invoicingConfigured: null
  export interface BillableSession {
    id: string; status: TreatmentSessionStatus; createdAt: string; completedAt: string | null; branchId: string | null;
    patient: { id: string; firstName: string; lastName: string; identificationNumber: string | null };
    treatment: { id: string; name: string; version: number }; price: string; taxRatePercent: string; compliant: boolean;
  }
  // OrdersService:
  eligibility(tenantId: string, orderId: string): Promise<BillingEligibility>;
  billableSessions(tenantId: string, query: BillableSessionsQuery): Promise<BillableSession[]>;
  ```
- Routes: `GET /orders/:id/billing-eligibility` y `GET /treatment-sessions/billable` (`billing.view`). La segunda se declara en `OrdersController`; como el módulo de A tiene `treatment-sessions/:id`, se prueba en Task 10 que `billable` no la captura (si la captura, registrar `OrdersModule` antes que `TreatmentSessionsModule` en `app.module.ts`).
- `billableSessions`: sesiones del tenant sin ítem vivo y en estado distinto de los no facturables, filtradas por sucursal (incluye las sin sucursal) y paciente; `compliant` = la evaluación de esa sesión sola (con `loadSessionBillingFacts`) no da códigos clínicos. Más recientes primero, máximo 100. Solo devuelve los campos de `BillableSession`.

Rules: `hasForm` y, para sesiones no iniciadas (`startedAt` nulo), `hasApplicableConsent` salen de `loadSessionFacts(tx, session, policy, version.consentTemplateVersionId, now)` (no necesita la sesión descifrada: solo se usan esos dos hechos); para sesiones iniciadas, `hasApplicableConsent = !policy.informedConsent.required || session.consentDocumentId !== null` (el consentimiento fijado al iniciar; revocarlo después no invalida la atención); `completed = session.completedAt !== null`; `patientName = firstName + ' ' + lastName`. Se evalúa en transacción serializable. Ningún hecho viene del cliente.

- [ ] **Step 1: Write failing tests**: `eligibility-facts.spec.ts` — sesión iniciada con `consentDocumentId` y documento luego `REVOKED` → `hasApplicableConsent: true`; sesión no iniciada sin documento firmado → `false`; `completedAt` presente → `completed: true`. `orders.service.spec.ts` — orden con una sesión `CANCELLED` ya pagada → `missing` incluye `SESSION_NOT_BILLABLE` y `items[0].codes` es `['SESSION_NOT_BILLABLE']`; orden sin receptor y con saldo → `['BILLING_PROFILE','BALANCE_DUE']`; la respuesta no tiene más claves que `eligible`, `missing`, `items`; `billableSessions` excluye una sesión con ítem vivo, incluye una cuyo único ítem tiene `releasedAt`, marca `compliant: false` una sin ficha requerida y devuelve exactamente las claves de `BillableSession`.
- [ ] **Step 2: Run** `npx jest src/orders` — Expected: FAIL.
- [ ] **Step 3: Implement** the loader and the route.
- [ ] **Step 4: Run** `npx jest src/orders src/treatment-sessions` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): billing eligibility of an order from the server-side facts of its sessions`.

### Task 9: Script de despliegue — perfiles desde el paciente y permisos heredados

**Files:**
- Create: `prisma/migrate-billing-profiles.ts`
- Modify: `package.json` (script `"prisma:migrate-billing-profiles": "ts-node prisma/migrate-billing-profiles.ts"`)
- Modify: `docs/DEPLOYMENT.md` (paso posterior a `prisma migrate deploy` en B1, y repetirlo en B2)
- Test: `test/billing-profiles-migration.e2e-spec.ts`

**Interfaces:**
- Consumes: `normalizeIdNumber`, `assertValidTaxIdentification` (Task 2).
- Produces:
  ```ts
  export interface BillingProfilesMigrationSummary { profilesCreated: number; profilesReused: number; linksCreated: number; skippedInvalid: { patientId: string; reason: string }[]; permissionsGranted: number }
  export async function migrateBillingProfiles(prisma: PrismaClient | PrismaService): Promise<BillingProfilesMigrationSummary>;
  ```
  Run as a script, it prints the summary as JSON and exits 0; it never prints identification numbers.

Rules: pacientes vivos (`deletedAt` nulo) con `billingName` y `billingTaxId`; tipo `RUC → '04'`, `CEDULA → '05'`, `PASSPORT → '06'`, otro → se salta; `kind` `COMPANY` si el tipo es `04` y el tercer dígito es 6 o 9, si no `PERSON`; `email` = `billingEmail ?? email del paciente`; si no hay correo, se salta (`reason: 'EMAIL_MISSING'`); identificación inválida → se salta (`reason: 'IDENTIFICATION_INVALID'`); perfil existente con la misma identificación → se reusa; vínculo existente → no se duplica; `isDefault` solo si el paciente no tiene predeterminado. Permisos: por cada usuario `PROFESIONAL` activo y cada permiso `billing.view`, `billing.create`, si no hay fila `UserPermission` de ese permiso, crea `granted: true`. Todo por tenant en transacciones; idempotente.

- [ ] **Step 1: Write the failing e2e test** `test/billing-profiles-migration.e2e-spec.ts` (Postgres; fixtures con `createTestTenant`): paciente con `billingTaxIdType 'CEDULA'`, `billingTaxId '1710034065'` → un perfil `05` predeterminado; otro paciente con la misma identificación → reusa el perfil (`profilesReused: 1`); paciente con RUC inválido → `skippedInvalid`; PROFESIONAL sin filas → recibe `billing.view` y `billing.create`; PROFESIONAL con `billing.create granted: false` → la conserva y solo recibe `billing.view`; segunda ejecución → todo en cero salvo `skippedInvalid`.
- [ ] **Step 2: Run** `DATABASE_URL_TEST=<test db> REDIS_URL="" npx jest --config ./test/jest-e2e.json --runInBand test/billing-profiles-migration.e2e-spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the script and the deployment note.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): deployment script that turns patient billing data into billing profiles and keeps professionals' billing access`.

### Task 10: Recorrido e2e de caja y documentación de la API

**Files:**
- Create: `test/cash-and-billing.e2e-spec.ts`
- Modify: `docs/API_ENDPOINTS.md`

**Interfaces:**
- Consumes: every route of Tasks 4–8 and A's treatment and session routes.

Fixtures: un tenant con sucursal, MASTER, un PROFESIONAL con perfil profesional y un ASISTENTE con `billing.view`, `billing.create` y `cash.manage` concedidos (sin `billing.adjust`); tres tratamientos: «Simple» (sin requisitos, `billingGate` por defecto), «Con ficha» (`medicalForm.required`) y «Con consentimiento» (`informedConsent.required` con una plantilla publicada); sesiones llevadas a `CLINICAL_COMPLETE` con `start` y `complete` como en `test/treatment-sessions.e2e-spec.ts`.

- [ ] **Step 1: Write the e2e tests:**
  - Recorrido: el ASISTENTE abre la caja; `GET /treatment-sessions/billable` lista las sesiones cerradas de dos pacientes con `compliant: true` y sin otras claves que las de `BillableSession`; crea la orden con ambas; crea un perfil `COMPANY` y lo asigna; dos pagos (`CASH 10.00`, `CREDIT_CARD` por el resto) → `PAID`; `billing-eligibility` → `eligible: true`; cierra la caja con lo contado igual a apertura + `10.00` → `difference` `0.00`.
  - E2E-02 (bloqueo): sesión «Con ficha» sin ficha → la orden pagada responde `missing` `['FINALIZED_MEDICAL_FORM', 'CLINICAL_COMPLETION']` (no está cerrada porque no pudo iniciar).
  - E2E-03 (bloqueo): sesión «Con consentimiento» sin firma → `SIGNED_APPLICABLE_CONSENT`.
  - E2E-04 (tercero): tras el recorrido, `GET /patients/:id` del paciente no cambió y no existe ningún `Patient` con la identificación de la empresa.
  - Caja: pagar con la caja cerrada → 409 `CASH_REGISTER_CLOSED`; cerrar con diferencia sin nota → 422 `CASH_CLOSING_NOTE_REQUIRED`.
  - Permisos: el ASISTENTE agrega un concepto libre → 403; el MASTER sí.
  - Tenants (E2E-09): un MASTER de otro tenant recibe 404 en la orden, el perfil, la caja y el pago (refund).
  - Concurrencia (Review Focus 1–3): dos pagos en paralelo por el saldo completo → uno 201 y la suma de pagos `RECORDED` igual al total; dos aperturas en paralelo → una 201 y una 409; la misma sesión en dos `POST /orders` en paralelo → uno 201 y otro 409.
  - Revocación (Review Focus 4): sesión «Con consentimiento» firmada y pagada, consentimiento revocado antes de iniciar → `SESSION_NOT_BILLABLE`; el pago se devuelve y la orden vuelve a `OPEN`.
  - Ruta: `GET /treatment-sessions/billable` responde 200 a un ASISTENTE (no lo captura una ruta `treatment-sessions/:id` de A).
- [ ] **Step 2: Run** `DATABASE_URL_TEST=<test db> REDIS_URL="" npx jest --config ./test/jest-e2e.json --runInBand test/cash-and-billing.e2e-spec.ts` — Expected: PASS (fix the code of the owning task if not).
- [ ] **Step 3: Document** every new route, its permission and its errors in `docs/API_ENDPOINTS.md`, in the format of A's section.
- [ ] **Step 4: Verify the whole API**: `npx jest` (unit), the full e2e suite with the same environment, `npm run build`, and `npx prettier --check` on every file touched in Tasks 1–10 — Expected: all PASS.
- [ ] **Step 5: Commit** `test(api): cash register, orders, payments and billing eligibility end to end; docs`.

---

## Web (`hcx-care-client`, en `web/.worktrees/cash-and-billing`)

### Task 11: Tipos, endpoints y hooks de caja

**Files:**
- Create: `src/types/cash.ts`
- Modify: `src/types/treatments.ts` (estados nuevos y `billingGate`), `src/lib/constants.ts`, `src/lib/api/endpoints.ts`
- Create: `src/hooks/useBillingProfiles.ts`, `src/hooks/useCashRegisters.ts`, `src/hooks/useOrders.ts`, `src/hooks/useOrders.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // types/cash.ts — mirror the API: BillingProfile, BillingProfileInput, CashRegister, CashRegisterDetail, CashCount,
  // OrderView (as Order), OrderItem, Payment, PaymentMethod, BillableSession, BillingEligibility, BillingCode, Paginated<T>
  export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string>; // Efectivo, Tarjeta de débito, Tarjeta de crédito, Transferencia, Otro
  export const SRI_ID_TYPE_LABELS: Record<'04'|'05'|'06'|'07', string>; // RUC, Cédula, Pasaporte, Consumidor final

  // types/treatments.ts
  // TreatmentSessionStatus += 'BILLING_PENDING' | 'BILLED' | 'BILLING_FAILED'; SESSION_STATUS_LABELS: 'En facturación', 'Facturada', 'Facturación fallida'
  // TreatmentRequirements += billingGate: { requireClinicalCompletion: boolean }

  // lib/api/endpoints.ts
  export const billingProfilesApi: { list(q?): ...; get(id); create(data); update(id, data); forPatient(patientId); link(patientId, data); unlink(patientId, profileId) };
  export const cashRegistersApi: { list(filters?); get(id); open(data); close(id, data) };
  export const ordersApi: { list(filters?); get(id); create(data); addItem(id, data); removeItem(id, itemId, version); updateItem(id, itemId, data); setBillingProfile(id, data); cancel(id, data); recordPayment(id, data, idempotencyKey); refundPayment(paymentId, data); eligibility(id); billableSessions(filters?) };

  // hooks
  useBillingProfiles(q), usePatientBillingProfiles(patientId), useCreateBillingProfile(), useUpdateBillingProfile(), useLinkBillingProfile(patientId), useUnlinkBillingProfile(patientId)
  useCashRegisters(filters), useOpenCashRegister(), useCloseCashRegister(), useCurrentCashRegister(branchId) // the OPEN one or null
  useOrders(filters), useOrder(id), useOrderEligibility(id), useBillableSessions(filters),
  useCreateOrder(), useAddOrderItem(id), useRemoveOrderItem(id), useUpdateOrderItem(id), useSetOrderBillingProfile(id), useCancelOrder(id), useRecordPayment(id), useRefundPayment(orderId)
  ```
  Query keys en `QUERY_KEYS`: `BILLING_PROFILES`, `CASH_REGISTERS`, `ORDERS`, `ORDER(id)`, `ORDER_ELIGIBILITY(id)`, `BILLABLE_SESSIONS`. Toda mutación de una orden invalida `ORDER(id)`, `ORDER_ELIGIBILITY(id)`, `ORDERS` y `BILLABLE_SESSIONS`; los pagos además `CASH_REGISTERS`. Errores con `toast.error(error.message)` como `useTreatments.ts`.
- `useRecordPayment` genera la `Idempotency-Key` con `crypto.randomUUID()` una vez por formulario abierto y la reusa si la misma petición se reintenta tras un error de red (sin respuesta del servidor); recibe la clave del componente.

- [ ] **Step 1: Write the failing test** `useOrders.test.tsx`: `useRecordPayment` llama a `ordersApi.recordPayment` con la clave recibida y, tras éxito, invalida las cinco claves; un error 409 `ORDER_VERSION_CONFLICT` invalida `ORDER(id)` para releer.
- [ ] **Step 2: Run** `npx vitest run src/hooks/useOrders.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** types, endpoints, constants and hooks.
- [ ] **Step 4: Run** `npx vitest run src/hooks && npm run type-check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): cash register, order and billing profile api and hooks`.

### Task 12: Pantalla de caja (`/cash`)

**Files:**
- Create: `src/app/(dashboard)/cash/page.tsx`
- Create: `src/features/cash/cash-page.tsx`, `cash-register-bar.tsx`, `cash-close-dialog.tsx`, `billable-sessions-tab.tsx`, `orders-tab.tsx`, `cash-page.test.tsx`, `cash-close-dialog.test.tsx`
- Modify: `src/components/layout/sidebar.tsx`, `src/components/layout/sidebar.test.tsx`

**Interfaces:**
- Consumes: hooks of Task 11; `useBranches` (existing).
- Produces: `CashPage` (default export of the route), `CashRegisterBar({ branchId })`, `CashCloseDialog({ register, open, onOpenChange })`, `BillableSessionsTab({ branchId })`, `OrdersTab({ branchId })`.

Behavior: selector de sucursal (la principal por defecto); `CashRegisterBar` muestra «Caja abierta desde HH:mm por {nombre}» o «Caja cerrada», con «Abrir caja» (monto inicial) y «Cerrar caja» solo con `can('cash.manage', isMaster)`. `CashCloseDialog` muestra el resumen por forma de pago, «Efectivo esperado», campo «Efectivo contado» y la diferencia en vivo; con diferencia ≠ 0 la nota es obligatoria antes de habilitar «Cerrar caja». «Por cobrar»: tabla de `useBillableSessions({ branchId })` con casillas, paciente, tratamiento, fecha, precio e insignia «Completa» / «Falta documentación»; «Cobrar» (con al menos una marcada) crea la orden y navega a `/cash/orders/{id}`. «Órdenes»: folio, receptor, total, saldo, estado; clic abre la orden. Sidebar: entrada «Caja» (`/cash`, icono `Wallet`) con `isEnabled('core.billing') && (can('billing.view', isMaster) || can('cash.manage', isMaster))`; la entrada «Facturación» pasa a `can('billing.view', isMaster)`.

- [ ] **Step 1: Write failing tests**: `cash-page.test.tsx` — sin `cash.manage` no aparece «Abrir caja»; marcar dos sesiones y «Cobrar» llama a `createOrder` con ambos ids y navega; la insignia dice «Falta documentación» con `compliant: false` y no muestra nada clínico. `cash-close-dialog.test.tsx` — esperado `35.00`, contado `33.00` → diferencia `-2.00` y botón deshabilitado hasta escribir la nota. `sidebar.test.tsx` — «Caja» visible para un ASISTENTE con `cash.manage` y oculta sin permisos.
- [ ] **Step 2: Run** `npx vitest run src/features/cash src/components/layout` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): cash register screen with sessions to charge, orders and the cash count`.

### Task 13: Orden (`/cash/orders/[id]`) sin emisión

**Files:**
- Create: `src/app/(dashboard)/cash/orders/[id]/page.tsx`
- Create: `src/features/cash/order-detail.tsx`, `billing-profile-picker.tsx`, `billing-profile-form.tsx`, `tax-identification.ts`, `order-items.tsx`, `order-payments.tsx`, `eligibility-checklist.tsx`, `eligibility-copy.ts`
- Test: `src/features/cash/order-detail.test.tsx`, `billing-profile-form.test.tsx`, `eligibility-checklist.test.tsx`, `tax-identification.test.ts`

**Interfaces:**
- Consumes: hooks of Task 11.
- Produces:
  ```ts
  // tax-identification.ts — the same rules as the API's Task 2 (copied, not imported): normalizeIdNumber, isValidCedula, taxIdentificationError(idType, idNumber, legalName): string | null
  // eligibility-copy.ts
  export function eligibilityLines(result: BillingEligibility, order: Order): { code: BillingCode; text: string }[];
  ```
  Textos exactos: `FINALIZED_MEDICAL_FORM` → «Falta la ficha de {paciente}»; `SIGNED_APPLICABLE_CONSENT` → «Falta el consentimiento firmado de {paciente}»; `CLINICAL_COMPLETION` → «La atención de {paciente} no está cerrada»; `SESSION_NOT_BILLABLE` → «La atención de {paciente} no se puede facturar (cancelada, sin consentimiento o ya facturada)»; `BILLING_PROFILE` → «Elige quién recibe la factura» (con `07` y total > 50: «Consumidor final solo hasta $50.00: elige un receptor con identificación»); `INVOICE_ITEMS` → «Agrega al menos un ítem con valor»; `BALANCE_DUE` → «Saldo pendiente: ${saldo}»; `INVOICING_NOT_CONFIGURED` → «Configura la facturación electrónica de la sucursal». Un código clínico produce una línea por ítem de `items`.

Behavior: secciones «Quién paga», «Ítems», «Pagos» y «Para emitir» (checklist). «Quién paga»: pestañas Paciente (perfiles vinculados de los pacientes de la orden), Otro particular y Empresa; buscador `useBillingProfiles(q)`; «Nuevo receptor» abre `BillingProfileForm` (tipo, identificación, nombre, correo, dirección, teléfono) que valida con `taxIdentificationError` antes de enviar y muestra el 409/422 del servidor tal cual; con un paciente en la orden, casilla «Vincular a {paciente}». «Ítems»: líneas con paciente (solo nombre), cantidad, precio, descuento, IVA y subtotal; «Agregar sesión» (de las por cobrar de la sucursal) y, con `billing.adjust`, «Concepto libre» (descripción, cantidad, precio, tarifa 0/5/15) y descuento por línea; quitar ítem. Todo deshabilitado si hay pagos o la orden no está `OPEN`, con el motivo visible. «Pagos»: forma, monto prellenado con el saldo, referencia; lista con «Devolver» (`billing.adjust`, motivo). «Para emitir»: `eligibilityLines`, o «Lista para facturar» si es elegible; el botón de emisión no existe en B1. Un 409 `ORDER_VERSION_CONFLICT` relee la orden y muestra «La orden cambió; revisa y vuelve a intentar». Nada se muestra como guardado antes de la respuesta del servidor.

- [ ] **Step 1: Write failing tests**: `tax-identification.test.ts` — los mismos vectores de Task 2. `billing-profile-form.test.tsx` — cédula `1710034066` muestra el error y no envía; un 409 del servidor se muestra. `eligibility-checklist.test.tsx` — cada código produce su texto exacto; dos sesiones sin ficha producen dos líneas con sus nombres. `order-detail.test.tsx` — con un pago registrado, «Agregar sesión» y «Concepto libre» están deshabilitados; sin `billing.adjust` no aparece «Concepto libre»; el monto del pago viene prellenado con el saldo; un fallo de red al pagar no agrega el pago a la lista.
- [ ] **Step 2: Run** `npx vitest run src/features/cash` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): order screen with the payer, items, payments and the issuing checklist`.

### Task 14: Perfiles del paciente, `billingGate` y estados de facturación

**Files:**
- Create: `src/features/billing/patient-billing-profiles.tsx`, `src/features/billing/patient-billing-profiles.test.tsx`
- Modify: `src/app/(dashboard)/patients/[id]/page.tsx` (sección de facturación)
- Modify: `src/features/admin/treatments/treatment-version-form.tsx`, `treatment-version-form.test.tsx`, `treatments-page.tsx`
- Modify: el componente que pinta el estado de la sesión en `src/features/treatment-sessions/` y `patient-treatments-tab.tsx` (insignias de los estados nuevos)

**Interfaces:**
- Consumes: `usePatientBillingProfiles`, `useLinkBillingProfile`, `useUnlinkBillingProfile`, `BillingProfileForm`, `BillingProfilePicker` (Tasks 11 y 13).
- Produces: `PatientBillingProfiles({ patientId })`.

Behavior: en la ficha del paciente, encima de la pestaña de facturas actual (Faktur sigue hasta B2), «Perfiles de facturación» con los vinculados, el predeterminado marcado, «Marcar como predeterminado», «Desvincular» y «Agregar» (buscar uno existente o crear); visible con `can('billing.view', isMaster)`, acciones con `billing.create`. El editor de versión de tratamiento agrega la casilla «Exigir cierre clínico para facturar», marcada por defecto y enviada como `billingGate.requireClinicalCompletion`; la tabla de tratamientos muestra «Factura tras cierre» cuando está activa. Las insignias de sesión usan las etiquetas de Task 11; `BILLING_PENDING`, `BILLED` y `BILLING_FAILED` no muestran acciones clínicas.

- [ ] **Step 1: Write failing tests**: `patient-billing-profiles.test.tsx` — lista con el predeterminado marcado; «Marcar como predeterminado» llama a `link` con `isDefault: true`; sin `billing.create` no hay acciones. `treatment-version-form.test.tsx` — la casilla viene marcada y se envía `billingGate: { requireClinicalCompletion: true }`; desmarcada envía `false`; una versión existente sin `billingGate` se muestra marcada.
- [ ] **Step 2: Run** `npx vitest run src/features/billing src/features/admin/treatments src/features/treatment-sessions` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify the whole web**: `npm run lint && npm run type-check && npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): billing profiles of the patient, the billing gate of a treatment and billing states`.
