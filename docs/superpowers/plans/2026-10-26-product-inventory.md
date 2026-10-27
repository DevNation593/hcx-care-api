# Catálogo de productos e inventario — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catálogo de productos con stock por lote y por sede, vendido como ítem `PRODUCT` de la orden de caja existente, con entradas, ajustes, traslados, costo, margen y vencimientos, en la API y en la web.

**Architecture:** La API agrega el módulo `api/src/inventory/`. La asignación FEFO es una función pura (`fefo.ts`); `StockAllocationService` aparta y libera unidades dentro de la transacción serializable de la orden, y `stock-ledger.ts` es el único lugar que cambia `StockLot.quantityOnHand`, siempre junto con su `StockMovement`. `OrdersService` llama a la asignación al agregar, quitar y cancelar; el snapshot fiscal toma el código del producto. La web agrega «Agregar producto» a la orden y la página `/inventory` con sus pestañas.

**Tech Stack:** NestJS 11, Prisma 6 (`Prisma.Decimal`), PostgreSQL, Jest + supertest; Next.js 14, React Query 5, Tailwind, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-26-product-inventory-design.md` (en `hcx-care-api`).

## Global Constraints

- API: rama `feat/product-inventory` en el checkout principal `api/` (ya creada desde `origin/dev`, con la spec commiteada). Web: rama `feat/product-inventory` en `web/`, creada desde `origin/dev` al empezar la Task 11. No se hace push sin pedirlo; los PR van contra `dev`.
- Prefijo de rutas `/api/v1/tenants/:tenantId`; todo controlador nuevo lleva `@RequireSection('core.billing.inventory')`.
- Rutas: `@Roles('MASTER')` + `@RequirePermission(<permiso>)`, la convención del repo para permisos concedibles.
- Permiso nuevo `inventory.manage`: `roles: ['MASTER']`, `grantable: ['PROFESIONAL', 'ASISTENTE']`. Vender usa `billing.create`; descuento, `billing.adjust` (igual que hoy).
- Errores con el formato `{ statusCode, code, message }`. `INSUFFICIENT_STOCK` agrega `available: number` y su `message` dice «Solo hay N unidades disponibles en esta sede.».
- Dinero `Decimal(10,2)` y tarifas `Decimal(5,2)` con `Prisma.Decimal`, nunca `number`; en JSON, cadenas con 2 decimales. Unidades de inventario `Int`.
- Tarifas de producto admitidas: 0, 5 y 15 (`SUPPORTED_FREE_TAX_RATES` de `src/orders/order-totals.ts`).
- «Hoy» es la fecha del consultorio: `TenantSettings.timezone`, o `DEFAULT_CLINIC_TIMEZONE` si no hay fila. Un lote con `expiresAt` igual a hoy aún se vende.
- `StockLot.quantityOnHand` solo cambia a través de `stock-ledger.ts`, y cada cambio escribe su `StockMovement` en la misma transacción.
- Los costos (`unitCost`, valorización, margen) solo salen en rutas con `inventory.manage`.
- Textos de interfaz y mensajes de error en español; comentarios de código en inglés.
- Sin dependencias nuevas en ningún repo.
- Archivos existentes con CRLF: editarlos con la herramienta Edit, no con parches que asuman `\n`.
- `npm run lint` de la API está roto (T-15): verificar con `npx prettier --check` sobre los archivos tocados.
- Después de cambiar `schema.prisma`, `npx prisma generate` antes de cualquier prueba.
- Base de datos de prueba: PostgreSQL desechable (`embedded-postgres` fuera del proyecto); nunca el `DATABASE_URL` de `api/.env`.
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Dos cajas piden la última unidad a la vez:** una obtiene la línea, la otra recibe `409 INSUFFICIENT_STOCK` (también cuando el choque lo detecta el `updateMany` condicional o la serialización), y ningún lote queda negativo. Prueba en Task 4 y Task 10.
2. **Lote que vence hoy en el borde del día:** a las 23:30 de Guayaquil (04:30 UTC del día siguiente) un lote con `expiresAt` = la fecha de Guayaquil aún se vende; a las 00:01 del día siguiente ya no. Prueba en Task 2.
3. **Cancelar una orden que mezcla sesiones y productos repartidos en dos lotes, uno ya vencido:** cada lote recupera exactamente lo que dio, el vencido incluido, y la sesión queda libre como hoy. Prueba en Task 5.
4. **Código del producto que solo difiere en mayúsculas o espacios de uno de tratamiento** (`' btx-01 '` frente a `BTX-01`): `409 PRODUCT_CODE_TAKEN`; y crear o renombrar un tratamiento con el código de un producto responde `409 TREATMENT_CODE_TAKEN`. Prueba en Task 3.
5. **Cantidad no entera o cero en una línea de producto** (`'2.5'`, `'0'`, `'-1'`): `422 ORDER_LINE_INVALID` antes de tocar el stock. Prueba en Task 5.

---

## API (`hcx-care-api`, checkout `api/`, rama `feat/product-inventory`)

### Task 1: Esquema, migración, sección, permiso y cableado

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261026000000_product_inventory/migration.sql`
- Modify: `src/prisma/prisma.service.ts` (`bindRlsDelegates`, `cleanDatabase`)
- Modify: `src/common/permissions/permission-catalog.ts`
- Modify: `src/common/sections/section-catalog.ts`
- Modify: `src/common/audit/billing-audit.ts` (`BillingAuditEntity`)
- Test: `src/common/permissions/permissions.spec.ts`, `src/common/sections/section-catalog.spec.ts`

**Interfaces:**
- Produces (Prisma), con los campos de la spec («Modelo de datos»):
  - enums `StockMovementKind { RECEIPT SALE SALE_RELEASE ADJUSTMENT TRANSFER_OUT TRANSFER_IN }`, `StockAdjustmentReason { COUNT DAMAGE EXPIRED INTERNAL_USE OTHER }`.
  - `OrderItemKind` += `PRODUCT`; `AuditEntity` += `PRODUCT`, `STOCK_RECEIPT`, `STOCK_ADJUSTMENT`, `STOCK_TRANSFER`.
  - models `Product`, `StockLot`, `StockReceipt`, `StockTransfer`, `StockMovement`, `OrderItemLot`; `OrderItem.productId String?` con relación `Restrict`.
  - `StockLot.expiresAt DateTime? @db.Date`; `StockLot.receiptId?` y `sourceLotId?` con `Restrict`.
  - `StockMovement.orderItemId String?` **sin relación** (un ítem quitado se borra; el movimiento queda como historial), con índice.
  - `OrderItemLot.orderItemId` con `onDelete: Cascade`; `lotId` con `Restrict`.
  - uniques `Product(tenantId, code)`, `Product(tenantId, name)`; índices de la spec.
  - FKs a `Tenant` `Cascade`; a `User`, `Branch`, `Product`, `StockLot`, `StockReceipt`, `StockTransfer` `Restrict`.
- Produces (SQL a mano en la migración):
  - `CREATE UNIQUE INDEX "Product_tenant_barcode_key" ON "Product"("tenantId", "barcode") WHERE "barcode" IS NOT NULL;`
  - `CHECK` en `StockLot`: `"quantityOnHand" >= 0`, `"quantityReceived" > 0`, `"unitCost" >= 0`; en `OrderItemLot`: `"quantity" > 0`; en `StockMovement`: `"quantity" <> 0`; en `Product`: `"price" > 0`, `"minStock" >= 0`.
  - `INSERT INTO "PlanModule" ("planId", "moduleKey") SELECT "planId", 'core.billing.inventory' FROM "PlanModule" WHERE "moduleKey" = 'core.billing.orders' ON CONFLICT DO NOTHING;`
  - `TenantModule` para cada consultorio con fila `core.billing.orders`: mismo `enabled`, origen `PLAN`, id `'section_' || md5("tenantId" || ':core.billing.inventory')`, `ON CONFLICT ("tenantId", "moduleKey") DO NOTHING` (patrón de `20261024000000_module_catalog`).
  - Sin políticas SQL de RLS: las tablas de la caja no las tienen; el aislamiento va por los delegados RLS de `PrismaService`.
- Produces (código):
  - `SECTION_KEYS` += `'core.billing.inventory'` después de `'core.billing.invoicing'`; definición `{ key: 'core.billing.inventory', name: 'Inventario', parent: 'core.billing', requires: ['core.billing.orders'] }`.
  - `PERMISSION_CATALOG` += `{ key: 'inventory.manage', group: 'Inventario', label: 'Administrar productos, stock y costos', roles: ['MASTER'], grantable: ['PROFESIONAL', 'ASISTENTE'] }`.
  - `BillingAuditEntity` += `'PRODUCT' | 'STOCK_RECEIPT' | 'STOCK_ADJUSTMENT' | 'STOCK_TRANSFER'`.

- [ ] **Step 1: Write the failing tests.** `permissions.spec.ts`: `rolePermissions('MASTER')` contiene `inventory.manage`; `rolePermissions('ASISTENTE')` no; `grantablePermissions('ASISTENTE')` y `grantablePermissions('PROFESIONAL')` sí. `section-catalog.spec.ts`: `sectionDefinition('core.billing.inventory')` tiene `parent: 'core.billing'` y `requires: ['core.billing.orders']`; el catálogo rechaza habilitarla sin `core.billing.orders` con `SECTION_DEPENDENCY`.
- [ ] **Step 2: Run** `npx jest src/common` — Expected: FAIL.
- [ ] **Step 3: Edit catalogs and `BillingAuditEntity`.** Run `npx jest src/common src/plans` — Expected: PASS (actualizar cualquier conteo fijo de secciones o permisos que falle).
- [ ] **Step 4: Edit `schema.prisma`** y crear la migración contra la base desechable: `DATABASE_URL=<scratch> npx prisma migrate dev --name product_inventory --create-only`, renombrar la carpeta a `20261026000000_product_inventory` y agregar el SQL a mano. Solo aditiva; valores de enum con `ALTER TYPE ... ADD VALUE`.
- [ ] **Step 5: Wire Prisma.** Delegados `product`, `stockLot`, `stockReceipt`, `stockTransfer`, `stockMovement`, `orderItemLot` en `bindRlsDelegates`. En `cleanDatabase`, antes de `'payment'`: `'orderItemLot'`, `'stockMovement'`; después de `'cashRegisterSession'`: `'stockLot'`, `'stockReceipt'`, `'stockTransfer'`, `'product'` (un traslado encadena lotes por `sourceLotId`: justo antes de borrar `stockLot`, `stockLot.updateMany({ data: { sourceLotId: null } })`).
- [ ] **Step 6: Verify** `npx prisma validate && npx prisma generate && DATABASE_URL=<scratch> npx prisma migrate reset --force --skip-seed && npx prisma migrate diff --from-url <scratch> --to-schema-datamodel prisma/schema.prisma --script` — Expected: solo sentencias sobre índices parciales y `CHECK` hechos a mano. `npx tsc --noEmit -p tsconfig.json` y `npx jest src/common src/app.module.spec.ts src/app.wiring.spec.ts` PASS.
- [ ] **Step 7: Commit** `feat(api): add products, stock lots and movements to the schema`.

### Task 2: FEFO y la fecha del consultorio

**Files:**
- Create: `src/inventory/fefo.ts`, `src/inventory/fefo.spec.ts`
- Modify: `src/common/utils/timezone.ts`
- Test: `src/common/utils/timezone.spec.ts` (crear si no existe)

**Interfaces:**
- Produces:
  - `zonedDateString(date: Date, timeZone?: string | null): string` — `'YYYY-MM-DD'` en la zona (con `Intl.DateTimeFormat('en-CA', { timeZone, year, month, day })`), cae a `DEFAULT_CLINIC_TIMEZONE` si la zona falta o es inválida.
  - `interface FefoLot { id: string; quantityOnHand: number; expiresAt: Date | null; receivedAt: Date; unitCost: Prisma.Decimal }`
  - `interface FefoTake { lotId: string; quantity: number; unitCost: Prisma.Decimal }`
  - `isLotExpired(expiresAt: Date | null, today: string): boolean` — `expiresAt.toISOString().slice(0, 10) < today` (los `@db.Date` llegan a medianoche UTC).
  - `allocateFefo(lots: FefoLot[], quantity: number, today: string): { takes: FefoTake[]; available: number }` — descarta vencidos y saldos 0; ordena por `expiresAt` ascendente con nulos al final y luego `receivedAt`; `available` es la suma de lo vendible; `takes` vacío si `available < quantity`.

- [ ] **Step 1: Write the failing tests.**
  - `zonedDateString(new Date('2026-10-27T04:30:00Z'), 'America/Guayaquil')` → `'2026-10-26'`; con `'Invalid/Zone'` → igual que con `'America/Guayaquil'`.
  - `isLotExpired(new Date('2026-10-26'), '2026-10-26')` → `false`; `isLotExpired(new Date('2026-10-25'), '2026-10-26')` → `true`; `isLotExpired(null, …)` → `false`.
  - `allocateFefo`: lotes A (vence 2026-12-01, 1 u.), B (vence 2027-03-01, 5 u.), C (sin vencimiento, 9 u.), D (vencido 2026-10-01, 4 u.); pedir 2 con hoy `'2026-10-26'` → `takes = [{A,1},{B,1}]`, `available = 15`. Pedir 16 → `takes = []`, `available = 15`. Dos lotes con el mismo vencimiento: sale primero el de `receivedAt` anterior. El `unitCost` de cada toma es el de su lote.
- [ ] **Step 2: Run** `npx jest src/inventory/fefo src/common/utils/timezone` — Expected: FAIL.
- [ ] **Step 3: Implement** las cuatro funciones.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): allocate stock first-expired-first-out`.

### Task 3: Catálogo de productos

**Files:**
- Create: `src/inventory/inventory-errors.ts`, `src/inventory/catalog-codes.ts`, `src/inventory/clinic-today.ts`, `src/inventory/dto/product.dto.ts`, `src/inventory/products.service.ts`, `src/inventory/products.service.spec.ts`, `src/inventory/products.controller.ts`, `src/inventory/inventory.module.ts`
- Modify: `src/app.module.ts`, `src/treatments/treatments.service.ts`, `src/treatments/treatments.service.spec.ts`, `src/common/sections/section-matrix.spec.ts`

**Interfaces:**
- Produces (`inventory-errors.ts`, cada una devuelve la excepción Nest con `{ statusCode, code, message }`): `productNotFound()` 404 `PRODUCT_NOT_FOUND`, `productInactive()` 409 `PRODUCT_INACTIVE`, `productCodeTaken()` 409 `PRODUCT_CODE_TAKEN`, `productNameTaken()` 409 `PRODUCT_NAME_TAKEN`, `productBarcodeTaken()` 409 `PRODUCT_BARCODE_TAKEN`, `productHasStock()` 409 `PRODUCT_HAS_STOCK`, `insufficientStock(available: number)` 409 `INSUFFICIENT_STOCK`, `lotNotFound()` 404 `STOCK_LOT_NOT_FOUND`, `lotExpiryRequired()` 422 `LOT_EXPIRY_REQUIRED`, `lotAlreadyExpired()` 422 `LOT_ALREADY_EXPIRED`, `stockBelowZero()` 422 `STOCK_BELOW_ZERO`, `adjustmentEmpty()` 422 `ADJUSTMENT_EMPTY`, `adjustmentNoteRequired()` 422 `ADJUSTMENT_NOTE_REQUIRED`, `transferSameBranch()` 422 `TRANSFER_SAME_BRANCH`, `lotNotInBranch()` 422 `LOT_NOT_IN_BRANCH`.
- Produces (`catalog-codes.ts`): `normalizeCatalogCode(code: string): string` (trim + mayúsculas); `isCodeUsedByTreatment(tx, tenantId, code, exceptTreatmentId?): Promise<boolean>`; `isCodeUsedByProduct(tx, tenantId, code, exceptProductId?): Promise<boolean>`.
- Produces (DTOs): `CreateProductDto { code; name; category?; barcode?; price: string; taxRatePercent: number; tracksExpiry: boolean; minStock?: number }` (validación como `CreateTreatmentDto`: `code` transformado con `normalizeCatalogCode`, `price` decimal > 0 con 2 decimales, `taxRatePercent` en `SUPPORTED_FREE_TAX_RATES`, `minStock` entero ≥ 0); `UpdateProductDto` = parcial de `CreateProductDto`; `SetProductActiveDto { isActive: boolean }`; `ListProductsQuery { search?; active?: boolean; page?; pageSize? }`; `ProductsForSaleQuery { branchId: string; search?; barcode? }`.
- Produces (`ProductsService`):
  - `listForSale(tenantId, query: ProductsForSaleQuery): Promise<ProductForSale[]>` — solo activos; `barcode` busca exacto (recortado); `search` por nombre o código, sin distinguir mayúsculas; máximo 20. `ProductForSale = { id, code, name, barcode, price, taxRatePercent, available: number }` (disponible no vencido en esa sede). Nunca incluye costo.
  - `list(tenantId, query: ListProductsQuery): Promise<{ items: ProductSummary[]; total: number; page: number; pageSize: number }>` (la forma de `OrdersService.list`) — `ProductSummary` = campos del producto + `stock: { branchId, branchName, available, belowMin: boolean }[]`.
  - `get(tenantId, id): Promise<ProductDetail>` — `ProductSummary` + `lots: { id, branchId, lotNumber, expiresAt, unitCost, quantityReceived, quantityOnHand, receivedAt, expired: boolean }[]` (solo lotes con saldo > 0, más los vencidos con saldo).
  - `create(tenantId, userId, dto)`, `update(tenantId, userId, id, dto)`, `setActive(tenantId, userId, id, dto)` → `ProductDetail`; auditan con `recordBillingAudit(entity: 'PRODUCT')`.
- Produces (`src/inventory/clinic-today.ts`): `clinicToday(db: Pick<Prisma.TransactionClient, 'tenantSettings'>, tenantId: string): Promise<string>` — lee `TenantSettings.timezone` y aplica `zonedDateString(new Date(), timezone)`; la usan Tasks 3, 5, 6 y 8.
- Produces (`ProductsController`, `tenants/:tenantId/products`): `GET /for-sale` (`billing.create`), `GET /`, `GET /:id` y `GET /:id/lots?branchId=` (los lotes de `ProductDetail` filtrados por sede) (`inventory.manage`), `POST /` y `PATCH /:id` (`inventory.manage`), `PATCH /:id/active` (`inventory.manage`).
- Modifies `TreatmentsService.create/update`: antes de escribir, `isCodeUsedByProduct` → `409 TREATMENT_CODE_TAKEN` (el `takenError` existente).

- [ ] **Step 1: Write the failing tests** en `products.service.spec.ts` (Prisma simulado como en `orders.service.spec.ts`):
  - `create` con `code: ' btx-01 '` cuando un tratamiento tiene `BTX-01` → `PRODUCT_CODE_TAKEN`; P2002 sobre `code` → `PRODUCT_CODE_TAKEN`, sobre `name` → `PRODUCT_NAME_TAKEN`, sobre el índice de `barcode` → `PRODUCT_BARCODE_TAKEN`.
  - `update` con `tracksExpiry` distinto cuando existe algún `StockLot` del producto → `PRODUCT_HAS_STOCK`.
  - `listForSale` no devuelve inactivos ni la clave `unitCost`; `available` excluye lotes vencidos.
  - `list` marca `belowMin` cuando `available < minStock` y `minStock > 0`.
  - En `treatments.service.spec.ts`: crear y actualizar con un código de producto → `TREATMENT_CODE_TAKEN`.
  - En `section-matrix.spec.ts`: `ProductsController` exige `core.billing.inventory`.
- [ ] **Step 2: Run** `npx jest src/inventory/products src/treatments src/common/sections` — Expected: FAIL.
- [ ] **Step 3: Implement** errores, `catalog-codes.ts`, `clinic-today.ts`, DTOs, servicio, controlador y `InventoryModule` (importado en `AppModule`).
- [ ] **Step 4: Run** the same command and `npx jest src/app.module.spec.ts src/app.wiring.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): add the product catalog`.

### Task 4: Libro de stock y asignación a órdenes

**Files:**
- Create: `src/inventory/stock-ledger.ts`, `src/inventory/stock-ledger.spec.ts`, `src/inventory/stock-allocation.service.ts`, `src/inventory/stock-allocation.service.spec.ts`
- Modify: `src/inventory/inventory.module.ts` (exporta `StockAllocationService`)

**Interfaces:**
- Consumes: `allocateFefo`, `isLotExpired` (Task 2); `insufficientStock` (Task 3).
- Produces (`stock-ledger.ts`, todas reciben `tx: Prisma.TransactionClient`):
  - `interface MovementInput { tenantId; actorId; lotId; productId; branchId; kind: StockMovementKind; quantity: number; unitCost: Prisma.Decimal; adjustmentReason?: StockAdjustmentReason; note?: string; receiptId?: string; transferId?: string; orderItemId?: string }`
  - `takeFromLot(tx, input: MovementInput): Promise<boolean>` — `input.quantity` negativo; `updateMany({ where: { id: lotId, tenantId, quantityOnHand: { gte: -quantity } }, data: { quantityOnHand: { decrement: -quantity } } })`; si `count === 0` devuelve `false` sin escribir el movimiento.
  - `addToLot(tx, input: MovementInput): Promise<void>` — `input.quantity` positivo; incrementa y escribe el movimiento.
  - `recordInitialMovement(tx, input: MovementInput): Promise<void>` — solo escribe el movimiento (lote recién creado con su saldo).
- Produces (`StockAllocationService`):
  - `reserve(tx, input: { tenantId: string; actorId: string; orderItemId: string; productId: string; branchId: string; quantity: number; today: string }): Promise<void>` — lee los lotes del producto en la sede con `SELECT … FOR UPDATE` (`tx.$queryRaw`) para serializar a quien compite por el mismo producto, llama a `allocateFefo`; si `takes` está vacío lanza `insufficientStock(available)`; por cada toma `takeFromLot` (`kind: 'SALE'`, `orderItemId`) y crea `OrderItemLot`; si algún `takeFromLot` devuelve `false`, lanza `insufficientStock(0)` (la transacción revierte todo).
  - `release(tx, input: { tenantId: string; actorId: string; orderItemIds: string[] }): Promise<void>` — por cada `OrderItemLot` de esos ítems, `addToLot` (`kind: 'SALE_RELEASE'`, mismo `unitCost`, `orderItemId`). No mira vencimientos. No borra los `OrderItemLot` (el ítem los arrastra si se borra; en una orden cancelada quedan como historia junto a `releasedAt`).

- [ ] **Step 1: Write the failing tests.**
  - `takeFromLot` con `count = 0` → `false` y sin `stockMovement.create`.
  - `reserve` de 2 con lotes A(1) y B(5) → dos `orderItemLot.create` (A:1, B:1) y dos movimientos `SALE` de −1.
  - `reserve` sin stock suficiente → lanza `INSUFFICIENT_STOCK` con `available` y no llama a `updateMany`.
  - `reserve` cuando el segundo `updateMany` devuelve `count = 0` → lanza `INSUFFICIENT_STOCK`.
  - `release` de un ítem con A:1 y B:1, con A vencido → dos `addToLot` de +1 con `SALE_RELEASE`.
- [ ] **Step 2: Run** `npx jest src/inventory/stock-` — Expected: FAIL.
- [ ] **Step 3: Implement** `stock-ledger.ts` y `StockAllocationService`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): reserve and release stock lots for order lines`.

### Task 5: Productos en la orden y en la factura

**Files:**
- Create: `src/common/sections/section-in-effect.ts`
- Modify: `src/common/guards/section.guard.ts` (usa `assertSectionInEffect`; `section.guard.spec.ts` debe seguir pasando sin cambios)
- Modify: `src/orders/dto/order.dto.ts`, `src/orders/orders.service.ts`, `src/orders/orders.service.spec.ts`, `src/orders/order-view.ts`, `src/orders/orders.module.ts`, `src/orders/orders.controller.ts` (descripción de errores en `@ApiOperation`), `src/invoicing/invoice-requests.service.ts`, `src/invoicing/invoice-requests.service.spec.ts`

**Interfaces:**
- Consumes: `StockAllocationService.reserve/release` (Task 4); `clinicToday`, `productNotFound`, `productInactive` (Task 3).
- Produces:
  - `AddOrderItemDto` acepta `kind: 'PRODUCT'` y `productId?: string`. Para `PRODUCT`, `quantity` debe ser un entero ≥ 1 (`/^[1-9]\d*$/`); si no, `lineInvalid('La cantidad debe ser un número entero mayor que cero.')` (`422 ORDER_LINE_INVALID`).
  - `assertSectionInEffect(db: Pick<Prisma.TransactionClient, 'tenantModule'>, tenantId: string, section: SectionKey): Promise<void>` en `src/common/sections/section-in-effect.ts`: la consulta y el `403 SECTION_NOT_ENABLED` que hoy están dentro de `SectionGuard.canActivate`, extraídos para que el guard y el servicio usen la misma función (`sectionWithParent` se mueve ahí).
  - `OrdersService.addItem`, rama `PRODUCT`: sin `billing.adjust` salvo descuento; `assertSectionInEffect(tx, tenantId, 'core.billing.inventory')`; producto del tenant (`PRODUCT_NOT_FOUND`) y activo (`PRODUCT_INACTIVE`); `LineData` con `kind: 'PRODUCT'`, `productId`, `description = product.name`, `unitPrice = product.price`, `taxRatePercent = product.taxRatePercent`, `patientId = dto.patientId ?? null`; crea el ítem y luego `reserve(... today: await clinicToday(tx, tenantId))`.
  - `LineData` agrega `'productId'`; `itemSnapshot` agrega `productId`.
  - `removeItem`: si el ítem es `PRODUCT`, `release` antes de `orderItem.delete`.
  - `cancel`: `release` de todos los ítems `PRODUCT` sin `releasedAt`, antes del `updateMany` de `releasedAt`.
  - `OrderView.items[]` agrega `productId: string | null`.
  - Snapshot fiscal: para `PRODUCT`, `localId = i.productId` y `code = i.product.code` (incluir `product: { select: { code: true } }` en la consulta de la orden).

- [ ] **Step 1: Write the failing tests** en `orders.service.spec.ts`:
  - `addItem` `PRODUCT` sin descuento no llama a `permissionChecker.assertAllowed`; con descuento sí, con `billing.adjust`.
  - `quantity` `'2.5'`, `'0'` y `'-1'` → `ORDER_LINE_INVALID` sin llamar a `reserve`.
  - Producto inactivo → `PRODUCT_INACTIVE`; de otro tenant → `PRODUCT_NOT_FOUND`.
  - Línea creada con precio, IVA y nombre del producto, y `reserve` llamado con `quantity: 2` y la sede de la orden.
  - `removeItem` de un `PRODUCT` llama a `release` con su id antes de `orderItem.delete`.
  - `cancel` de una orden con una sesión y dos productos llama a `release` con los ids de los dos productos y deja la sesión liberada como hoy.
  - `invoice-requests.service.spec.ts`: una línea `PRODUCT` lleva `code` del producto y `localId` igual a su `productId`.
- [ ] **Step 2: Run** `npx jest src/orders src/invoicing` — Expected: FAIL.
- [ ] **Step 3: Implement.** Importar `InventoryModule` en `OrdersModule`.
- [ ] **Step 4: Run** `npx jest src/orders src/invoicing src/inventory src/common/guards` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): sell catalog products from the cash order`.

### Task 6: Entradas de compra

**Files:**
- Create: `src/inventory/dto/stock-receipt.dto.ts`, `src/inventory/stock-receipts.service.ts`, `src/inventory/stock-receipts.service.spec.ts`, `src/inventory/stock.controller.ts`
- Modify: `src/inventory/inventory.module.ts`, `src/common/sections/section-matrix.spec.ts`

**Interfaces:**
- Consumes: `recordInitialMovement` (Task 4), `clinicToday` y errores (Task 3), `assertBranchAvailable` de `src/branches/branches.service.ts`.
- Produces:
  - `CreateStockReceiptDto { branchId; supplierName?; documentNumber?; receivedAt?: string (ISO); note?; lines: { productId; quantity: number (entero ≥ 1); unitCost: string (≥ 0, 2 decimales); lotNumber?; expiresAt?: string ('YYYY-MM-DD') }[] (1–100) }`.
  - `StockReceiptsService.create(tenantId, userId, dto): Promise<StockReceiptView>` — `runSerializableTransaction`; sede disponible; cada producto del tenant y activo; `expiresAt` obligatorio si `tracksExpiry` (`LOT_EXPIRY_REQUIRED`) y no anterior a `clinicToday` (`LOT_ALREADY_EXPIRED`); crea la recepción, un `StockLot` por línea (`quantityReceived = quantityOnHand = quantity`) y su movimiento `RECEIPT`; audita `STOCK_RECEIPT`. `receivedAt` por defecto ahora.
  - `StockReceiptsService.list(tenantId, query: { branchId?; page?; pageSize? })`, `get(tenantId, id)`; `StockReceiptView = { id, branch: { id, name }, supplierName, documentNumber, receivedAt, note, createdBy: { id, firstName, lastName }, lines: { lotId, product: { id, code, name }, quantity, unitCost, lotNumber, expiresAt }[] }`.
  - `StockController` (`tenants/:tenantId`, `inventory.manage`): `POST /stock-receipts`, `GET /stock-receipts`, `GET /stock-receipts/:id`.

- [ ] **Step 1: Write the failing tests:** `LOT_EXPIRY_REQUIRED`; `LOT_ALREADY_EXPIRED` con `expiresAt` = ayer del consultorio, aceptado con hoy; sede inactiva → `BRANCH_NOT_AVAILABLE`; producto inactivo → `PRODUCT_INACTIVE`; dos líneas crean dos lotes y dos movimientos `RECEIPT` con su costo; `StockController` exige `core.billing.inventory` en `section-matrix.spec.ts`.
- [ ] **Step 2: Run** `npx jest src/inventory/stock-receipts src/common/sections` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): receive purchased stock into lots`.

### Task 7: Ajustes, traslados y movimientos

**Files:**
- Create: `src/inventory/dto/stock-adjustment.dto.ts`, `src/inventory/dto/stock-transfer.dto.ts`, `src/inventory/stock-adjustments.service.ts`, `src/inventory/stock-adjustments.service.spec.ts`, `src/inventory/stock-transfers.service.ts`, `src/inventory/stock-transfers.service.spec.ts`, `src/inventory/stock-movements.service.ts`
- Modify: `src/inventory/stock.controller.ts`, `src/inventory/inventory.module.ts`

**Interfaces:**
- Consumes: `takeFromLot`, `addToLot`, `recordInitialMovement` (Task 4); errores (Task 3); `assertBranchAvailable`.
- Produces:
  - `CreateStockAdjustmentDto { delta?: number; countedQuantity?: number; reason: StockAdjustmentReason; note?: string }` — exactamente uno de `delta` o `countedQuantity` (enteros; `countedQuantity ≥ 0`).
  - `StockAdjustmentsService.adjust(tenantId, userId, lotId, dto): Promise<LotView>` — lote del tenant (`STOCK_LOT_NOT_FOUND`); `delta = countedQuantity − quantityOnHand` si viene `countedQuantity`; `0` → `ADJUSTMENT_EMPTY`; `OTHER` sin nota → `ADJUSTMENT_NOTE_REQUIRED`; negativo con `takeFromLot` (si devuelve `false` → `STOCK_BELOW_ZERO`), positivo con `addToLot`; movimiento `ADJUSTMENT` con motivo; audita `STOCK_ADJUSTMENT`.
  - `CreateStockTransferDto { fromBranchId; toBranchId; note?; lines: { lotId; quantity: number }[] (1–100) }`.
  - `StockTransfersService.create(tenantId, userId, dto): Promise<StockTransferView>` — sedes distintas (`TRANSFER_SAME_BRANCH`) y disponibles; cada lote del tenant y en `fromBranchId` (`LOT_NOT_IN_BRANCH`); por línea `takeFromLot` (`TRANSFER_OUT`; `false` → `insufficientStock(lot.quantityOnHand)`), nuevo `StockLot` en destino con `lotNumber`, `expiresAt`, `unitCost`, `sourceLotId`, `receivedAt` del lote de origen, y `recordInitialMovement` (`TRANSFER_IN`); audita `STOCK_TRANSFER`. `list` y `get` como en recepciones.
  - `StockMovementsService.list(tenantId, query: { productId?; branchId?; kind?; from?; to?; page?; pageSize? })`, ordenado por `createdAt` descendente.
  - Rutas en `StockController` (`inventory.manage`): `POST /stock-lots/:id/adjustments`, `POST /stock-transfers`, `GET /stock-transfers`, `GET /stock-transfers/:id`, `GET /stock-movements`.

- [ ] **Step 1: Write the failing tests:** ajuste con `countedQuantity` igual al saldo → `ADJUSTMENT_EMPTY`; `delta: -5` sobre 3 → `STOCK_BELOW_ZERO`; `OTHER` sin nota → `ADJUSTMENT_NOTE_REQUIRED`; `countedQuantity: 1` sobre 3 escribe un movimiento de −2 con su motivo. Traslado a la misma sede → `TRANSFER_SAME_BRANCH`; lote de otra sede → `LOT_NOT_IN_BRANCH`; traslado de 2 de un lote crea el lote destino con mismo número, vencimiento y costo, `sourceLotId`, y movimientos −2 / +2.
- [ ] **Step 2: Run** `npx jest src/inventory/stock-adjustments src/inventory/stock-transfers` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx jest src/inventory` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): adjust lots and transfer stock between branches`.

### Task 8: Reportes de inventario

**Files:**
- Create: `src/inventory/inventory-reports.service.ts`, `src/inventory/inventory-reports.service.spec.ts`, `src/inventory/inventory-reports.controller.ts`
- Modify: `src/inventory/inventory.module.ts`, `src/common/sections/section-matrix.spec.ts`

**Interfaces:**
- Consumes: `clinicToday`, `isLotExpired`.
- Produces (`InventoryReportsController`, `tenants/:tenantId/inventory/reports`, `inventory.manage`):
  - `GET /valuation?branchId=` → `{ branches: { branchId, branchName, units, value: string, products: { productId, code, name, units, value: string }[] }[]; totalValue: string }` — `Σ quantityOnHand × unitCost` de todos los lotes con saldo, vencidos incluidos.
  - `GET /expiring?days=30|60|90&branchId=` → `{ expired: ExpiringLot[]; expiring: ExpiringLot[] }`, `ExpiringLot = { lotId, product: { id, code, name }, branch: { id, name }, lotNumber, expiresAt, quantityOnHand, value: string }`; `days` fuera de 30, 60 o 90 → `400 VALIDATION_ERROR` del `ValidationPipe`.
  - `GET /low-stock?branchId=` → `{ productId, code, name, branchId, branchName, available, minStock }[]`, solo productos activos con `minStock > 0` y disponible no vencido menor que `minStock` (incluye sedes con 0).
  - `GET /margin?from=&to=&branchId=` → `{ revenue: string; cost: string; margin: string; products: { productId, code, name, units, revenue, cost, margin }[] }` — líneas `PRODUCT` de órdenes `PAID` o `INVOICED` con `createdAt` de la orden en el período, sin `releasedAt`; `revenue = Σ lineSubtotal`, `cost = Σ OrderItemLot.quantity × unitCost`. Período de más de 366 días → `422 REPORT_RANGE_TOO_LONG`.

- [ ] **Step 1: Write the failing tests:** valorización suma lotes de dos sedes por separado; por vencer con hoy `'2026-10-26'` y `days: 30` pone un lote del 2026-11-20 en `expiring` y uno del 2026-10-25 en `expired`; bajo mínimo lista una sede con 0 y omite productos con `minStock = 0`; margen excluye órdenes `OPEN` y `CANCELLED` y calcula `margin = revenue − cost`; rango de 400 días → `REPORT_RANGE_TOO_LONG`; el controlador exige la sección.
- [ ] **Step 2: Run** `npx jest src/inventory/inventory-reports src/common/sections` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): report inventory value, expiring lots, low stock and margin`.

### Task 9: Seed del Estudio Aurora

**Files:**
- Modify: `prisma/seed-aesthetic-studio.ts`, `test/seed-coverage.spec.ts`

**Interfaces:**
- Produces: en Aurora, productos `PROT-SPF50` «Protector solar SPF50» ($18.00, IVA 15, `tracksExpiry`, `minStock: 5`), `SER-VITC` «Sérum vitamina C» ($32.00, IVA 15, `tracksExpiry`, `minStock: 3`), `ESP-FACIAL` «Esponja facial» ($4.50, IVA 15, sin vencimiento, `minStock: 10`). Una recepción en la sede principal: protector lote `PS-2611` con vencimiento a 20 días de hoy (4 u., costo 9.00) y `PS-2704` a 180 días (12 u., costo 9.50); sérum `VC-2705` a 210 días (6 u., costo 15.00); esponja sin lote (6 u., costo 1.20, por debajo de su mínimo). Movimientos `RECEIPT` por cada lote. Códigos distintos de los de los tratamientos de Aurora.

- [ ] **Step 1: Write the failing test** en `seed-coverage.spec.ts`: Aurora tiene 3 productos; cada lote tiene `quantityOnHand` igual a la suma de sus movimientos; ningún código de producto coincide con un código de tratamiento del tenant; hay un lote que vence en menos de 30 días y un producto bajo su mínimo.
- [ ] **Step 2: Run** `npx jest test/seed-coverage.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** en `seedAestheticStudio`.
- [ ] **Step 4: Run** the same command, y `DATABASE_URL=<scratch> STORAGE_DRIVER=local CLINICAL_ENCRYPTION_KEYS=<clave> npx ts-node prisma/seed.ts` — Expected: PASS y el seed termina sin errores.
- [ ] **Step 5: Commit** `feat(seed): stock the Aurora studio with products and lots`.

### Task 10: E2E de inventario

**Files:**
- Create: `test/inventory.e2e-spec.ts`

**Interfaces:**
- Consumes: `createTestTenant`, `TEST_PASSWORD` de `test/helpers/create-test-tenant.ts`; el arranque de `test/cash-and-billing.e2e-spec.ts` (AppModule, `ValidationPipe`, `STORAGE_LOCAL_PATH` temporal).

- [ ] **Step 1: Write the e2e** con los pasos de la spec («Pruebas», e2e 1–7): recepción con dos lotes en la sede Norte; orden con 2 unidades repartidas; pago en la caja abierta; facturación: crear con Prisma una `InvoicingConnection` activa y el `BranchEmissionPoint` de la sede Norte (sin llamar al proveedor), `POST /orders/:id/invoice-requests`, leer la fila `InvoiceRequest` y descifrar `snapshotEncrypted` con `app.get(ClinicalCryptoService).decrypt(tenantId, …)` como hace `test/invoicing.e2e-spec.ts`; la línea lleva `code` del producto y `localId` igual a su id; otra orden cancelada que devuelve el stock; traslado a la sede Sur; ajuste `DAMAGE`; para cada lote, `quantityOnHand` = suma de movimientos; concurrencia con `Promise.all` de dos `POST /orders/:id/items` sobre la última unidad (uno 201, otro 409 `INSUFFICIENT_STOCK`, saldo 0); otro tenant recibe 404 en `GET /products/:id` y en el `POST` del ítem.
- [ ] **Step 2: Run** `DATABASE_URL_TEST=<scratch>/psic_clinic_test REDIS_URL="" npx jest --config ./test/jest-e2e.json --runInBand test/inventory.e2e-spec.ts` — Expected: PASS. Si falla por la parte de facturación, compararlo con la línea base de `invoicing.e2e-spec.ts` en `origin/dev` antes de culpar al cambio.
- [ ] **Step 3: Run** `npx jest` (unitarias completas), `npm run build` y `npx prettier --check` sobre los archivos tocados — Expected: PASS.
- [ ] **Step 4: Commit** `test(api): inventory end to end`.

---

## Web (`web/`, rama `feat/product-inventory`)

### Task 11: Tipos, cliente de API, hooks y sección

**Files:**
- Create: `src/types/inventory.ts`, `src/hooks/useInventory.ts`, `src/hooks/useInventory.test.tsx`
- Modify: `src/types/index.ts` (`SECTION_KEYS`), `src/types/cash.ts` (`OrderItemKind`, `AddOrderItemInput`, `OrderItem`), `src/lib/constants.ts` (`API_ENDPOINTS`, `QUERY_KEYS`), `src/lib/api/endpoints.ts`

**Interfaces:**
- Produces:
  - Tipos espejo de la API: `ProductForSale`, `ProductSummary`, `ProductDetail`, `StockLotView`, `CreateProductInput`, `UpdateProductInput`, `StockReceipt`, `CreateStockReceiptInput`, `StockAdjustmentReason`, `CreateStockAdjustmentInput`, `StockTransfer`, `CreateStockTransferInput`, `StockMovement`, `ValuationReport`, `ExpiringReport`, `LowStockRow`, `MarginReport`.
  - `OrderItemKind` += `'PRODUCT'`; `AddOrderItemInput.productId?: string`; `OrderItem.productId: string | null`.
  - `API_ENDPOINTS`: `PRODUCTS`, `PRODUCTS_FOR_SALE`, `PRODUCT(id)`, `PRODUCT_ACTIVE(id)`, `STOCK_RECEIPTS`, `STOCK_RECEIPT(id)`, `STOCK_LOT_ADJUSTMENTS(lotId)`, `STOCK_TRANSFERS`, `STOCK_TRANSFER(id)`, `STOCK_MOVEMENTS`, `INVENTORY_REPORT(kind)` (todas con `tenantId` primero, como las de caja).
  - `productsApi { forSale, list, get, create, update, setActive }`, `inventoryApi { receipts, receipt, createReceipt, adjustLot, transfers, transfer, createTransfer, movements, report }` en `endpoints.ts`.
  - Hooks: `useProductsForSale(branchId, search)` (deshabilitado sin `branchId` o con búsqueda vacía), `useProducts(query)`, `useProduct(id)`, `useCreateProduct()`, `useUpdateProduct(id)`, `useSetProductActive(id)`, `useStockReceipts(query)`, `useCreateStockReceipt()`, `useAdjustLot(productId)`, `useStockTransfers(query)`, `useCreateStockTransfer()`, `useInventoryReport(kind, params)`. Las mutaciones invalidan `QUERY_KEYS.PRODUCTS` y `QUERY_KEYS.INVENTORY_REPORTS`; ninguna muestra el toast genérico de error (el formulario muestra el `message` de la API).

- [ ] **Step 1: Create the web branch** `git -C web switch -c feat/product-inventory origin/dev` (después de `git -C web fetch origin dev`).
- [ ] **Step 2: Write the failing tests** en `useInventory.test.tsx` (patrón de `useOrders.test.tsx`): `useProductsForSale` no consulta sin `branchId`; `useCreateStockReceipt` invalida productos y reportes al terminar.
- [ ] **Step 3: Run** `npx vitest run src/hooks/useInventory` — Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the same command and `npm run type-check` — Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): inventory types, API client and hooks`.

### Task 12: Agregar producto a la orden

**Files:**
- Create: `src/features/cash/product-picker.tsx`, `src/features/cash/product-picker.test.tsx`
- Modify: `src/features/cash/order-items.tsx`, `src/features/cash/order-detail.test.tsx`

**Interfaces:**
- Consumes: `useProductsForSale`, `useAddOrderItem`.
- Produces: `ProductPicker({ branchId, disabled, onAdd }: { branchId: string; disabled: boolean; onAdd: (productId: string, quantity: number) => Promise<void> })`. Campo de búsqueda con `aria-label="Buscar producto o código de barras"`; Enter con un texto que coincide exacto con un `barcode` de los resultados agrega 1 unidad de ese producto y limpia el campo; cada resultado muestra nombre, código, precio y «N disponibles» y tiene cantidad (entero ≥ 1) y botón «Agregar». Sin disponible, el botón queda deshabilitado con el texto «Sin stock en esta sede».
- `OrderItems` muestra el `ProductPicker` cuando `isEnabled('core.billing.inventory')` y la orden está editable; llama a `addItem.mutateAsync({ version, kind: 'PRODUCT', productId, quantity: String(quantity) })` con el mismo `run(...)` que las sesiones, así que un `409 INSUFFICIENT_STOCK` muestra el `message` de la API.

- [ ] **Step 1: Write the failing tests:** escribir un código de barras y Enter llama a `onAdd(id, 1)`; un producto con `available: 0` tiene el botón deshabilitado; en `order-detail.test.tsx`, un `409 INSUFFICIENT_STOCK` con `message: 'Solo hay 1 unidades disponibles en esta sede.'` se muestra tal cual; sin `core.billing.inventory` no aparece el buscador.
- [ ] **Step 2: Run** `npx vitest run src/features/cash` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): add catalog products to a cash order`.

### Task 13: Página de inventario — productos

**Files:**
- Create: `src/app/(dashboard)/inventory/page.tsx`, `src/features/inventory/inventory-page.tsx`, `src/features/inventory/products-tab.tsx`, `src/features/inventory/product-form.tsx`, `src/features/inventory/product-detail-dialog.tsx`, `src/features/inventory/adjust-lot-form.tsx`, `src/features/inventory/inventory-page.test.tsx`, `src/features/inventory/product-form.test.tsx`
- Modify: `src/components/layout/sidebar.tsx` (y su prueba si existe una de entradas)

**Interfaces:**
- Consumes: hooks de Task 11; `SectionGate`; `useMyPermissions`; `formatMoney` de `src/features/cash/money.ts`.
- Produces:
  - Ruta `/inventory` dentro de `<SectionGate section="core.billing.inventory">`.
  - `InventoryPage` con pestañas «Productos», «Entradas», «Traslados», «Por vencer», «Valorización y margen»; las cuatro últimas se completan en Tasks 14–15 (en esta tarea muestran solo su título).
  - Entrada de barra lateral `{ name: 'Inventario', href: '/inventory', icon: Package, show: isEnabled('core.billing.inventory') && can('inventory.manage', isMaster) }`, después de «Caja».
  - `ProductForm` (alta y edición): código, nombre, categoría, código de barras, precio, IVA (0, 5, 15), lleva vencimiento, stock mínimo; `tracksExpiry` deshabilitado al editar un producto que tiene lotes; muestra el `message` de la API en errores 409/422.
  - `ProductsTab`: tabla con código, nombre, precio, stock por sede y marca «Bajo mínimo»; botones «Nuevo producto», editar y activar/desactivar.
  - `ProductDetailDialog`: lotes por sede con número, vencimiento (marca «Vencido»), costo, recibido y disponible; cada lote abre `AdjustLotForm` (diferencia o cantidad contada, motivo de la lista con etiquetas «Conteo físico», «Daño», «Vencido», «Uso interno», «Otro», nota obligatoria con «Otro»).

- [ ] **Step 1: Write the failing tests:** la página no muestra la pestaña ni la barra lateral sin `inventory.manage`; `ProductForm` envía `taxRatePercent` numérico y `price` como cadena; con lotes, `tracksExpiry` queda deshabilitado; `AdjustLotForm` exige nota con «Otro».
- [ ] **Step 2: Run** `npx vitest run src/features/inventory src/components/layout` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): inventory page with the product catalog and lot adjustments`.

### Task 14: Entradas y traslados

**Files:**
- Create: `src/features/inventory/receipts-tab.tsx`, `src/features/inventory/receipt-form.tsx`, `src/features/inventory/transfers-tab.tsx`, `src/features/inventory/transfer-form.tsx`, `src/features/inventory/receipt-form.test.tsx`, `src/features/inventory/transfer-form.test.tsx`
- Modify: `src/features/inventory/inventory-page.tsx`

**Interfaces:**
- Consumes: `useStockReceipts`, `useCreateStockReceipt`, `useStockTransfers`, `useCreateStockTransfer`, `useProducts`, `useProduct`, `useBranches`.
- Produces:
  - `ReceiptForm`: sede, proveedor, número de documento, fecha, nota y líneas (producto, cantidad, costo unitario, lote, vencimiento); el vencimiento es obligatorio en la línea cuando el producto elegido lo lleva, antes de enviar.
  - `TransferForm`: sede de origen y destino (distintas), y líneas elegidas de los lotes con saldo del producto en la sede de origen, con cantidad hasta su disponible.
  - Listas con fecha, sede(s), número de líneas y quién lo registró.

- [ ] **Step 1: Write the failing tests:** `ReceiptForm` no envía si un producto con vencimiento no tiene fecha y lo señala en esa línea; `TransferForm` impide la misma sede en origen y destino y ofrece solo lotes de la sede de origen.
- [ ] **Step 2: Run** `npx vitest run src/features/inventory` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): stock receipts and transfers`.

### Task 15: Por vencer, valorización y margen; verificación final

**Files:**
- Create: `src/features/inventory/expiring-tab.tsx`, `src/features/inventory/valuation-tab.tsx`, `src/features/inventory/reports-tabs.test.tsx`
- Modify: `src/features/inventory/inventory-page.tsx`
- Modify (repo raíz, sin git): `TAREAS_PENDIENTES.md` filas §37–41 y §42–43

**Interfaces:**
- Consumes: `useInventoryReport`.
- Produces:
  - `ExpiringTab`: selector 30/60/90 días y sede; secciones «Vencidos» y «Por vencer» con producto, sede, lote, vencimiento, unidades y valor.
  - `ValuationTab`: valor por sede y producto, y margen del período (desde/hasta, sede) con venta, costo y margen por producto. Importes con `formatMoney`.

- [ ] **Step 1: Write the failing tests:** cambiar a 60 días vuelve a pedir el reporte con `days: 60`; el margen muestra `revenue`, `cost` y `margin` formateados.
- [ ] **Step 2: Run** `npx vitest run src/features/inventory` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run lint && npm run type-check && npx vitest run && npm run build` en `web/` — Expected: PASS.
- [ ] **Step 5: Verify in the browser** contra la API con la base desechable sembrada (receta de la memoria del proyecto: API desde `dist/src/main.js` con `DATABASE_URL`, `REDIS_URL=""`, `CLINICAL_ENCRYPTION_KEYS` y `STORAGE_LOCAL_PATH`; web con la entrada `web` de `.claude/launch.json`): como titular de Aurora, vender 2 protectores desde una orden, ver bajar el disponible, cancelar la orden y verlo volver, y ver el lote por vencer en la pestaña correspondiente.
- [ ] **Step 6: Update `TAREAS_PENDIENTES.md`**: §37–41 pasa a «Parcial» con caja, pagos, devoluciones, factura electrónica y venta de productos hechos, y faltan recibos, paquetes y convenios; §42–43 pasa a «Hecho (26 oct.)» con lo que cubre y lo que queda fuera (insumos de tratamientos).
- [ ] **Step 7: Commit** `feat(web): expiring lots, inventory value and margin`.
