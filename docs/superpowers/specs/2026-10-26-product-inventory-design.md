# Catálogo de productos e inventario sobre la caja — diseño

Fecha: 2026-10-26 · Repositorios: api y web · Ramas: `feat/product-inventory` en cada uno, creadas
desde `dev`

Se apoya en la caja de `2026-10-15-cash-and-billing-design.md` (sub-proyecto B1, PR api #53) y en
la emisión con `api-emite-facil` (B2). Cubre §42–43 del documento multiespecialidad y la parte de
inventario de T-27 en `TAREAS_PENDIENTES.md`.

## Problema

Los estudios estéticos venden productos (protector solar, cremas, sueros) además de sus
tratamientos. Hoy la caja solo puede cobrar un producto como concepto libre (`OrderItemKind.FREE`):
exige `billing.adjust`, la cajera escribe precio e IVA a mano, nada descuenta stock, y la web ni
siquiera ofrece ese tipo de ítem. No hay forma de saber cuántas unidades quedan, cuánto vale el
inventario, qué está por vencer ni cuánto margen deja una venta.

## Objetivo

Un catálogo de productos con stock por sede, vendido desde la orden de caja existente. No es un
punto de venta aparte: la venta usa la misma `Order`, los mismos `Payment`, la misma caja abierta y
la misma factura.

Éxito: la cajera abre la orden de la sede Norte, escanea el protector solar y pide 2 unidades. El
servidor aparta 1 del lote que vence en diciembre y 1 del que vence en marzo. La paciente paga y
la factura sale con el código del producto como código principal. Otra orden con el mismo producto
se cancela y sus unidades vuelven a sus lotes. El titular registra la compra que llega, traslada 5
unidades a la sede Sur, da de baja una unidad rota con un ajuste y ve el valor del inventario, el
margen del mes y lo que vence en 30 días. Dos cajas que piden la última unidad a la vez: una la
obtiene y la otra recibe `409 INSUFFICIENT_STOCK`.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Alcance | Solo productos que se venden. Los insumos que consume un tratamiento quedan fuera |
| Movimientos | Entradas, ajustes, traslados entre sedes, costo y margen, lotes y vencimiento |
| Modelo de stock | Saldo por lote, actualizado en la misma transacción que el movimiento que lo cambia, más un registro de movimientos que nunca se modifica |
| Dónde vive el stock | Por sede. Las órdenes y las cajas ya son por sede |
| Cuándo sale del stock | Al agregar la línea a la orden. Quitar la línea o cancelar la orden devuelve las unidades a sus mismos lotes |
| Orden de salida | FEFO: primero el lote que vence antes; los lotes sin vencimiento al final; a igual vencimiento, el que entró primero. Un lote vencido nunca se vende |
| Unidades | Enteras. Un producto se vende y se cuenta por unidad |
| Versiones de producto | No hay. La línea de la orden copia precio e IVA al agregarse, así que cambiar el catálogo no altera órdenes anteriores |
| Lotes | Todo ingreso crea un lote, con número opcional. El vencimiento es obligatorio solo si el producto lo lleva (`tracksExpiry`) |
| Costo | Por lote (identificación específica). El costo de una venta es el de los lotes que consumió |
| Stock mínimo | Uno por producto, comparado contra cada sede |
| Código del producto | Código principal de la factura. Único en el tenant entre tratamientos y productos, porque los dos van al mismo espacio de SKU de emite-facil |
| Devoluciones | Antes de facturar: reembolso del pago y quitar la línea (flujo actual). Después de facturar no hay devolución, igual que con las sesiones; si el producto vuelve físicamente, se registra un ajuste |
| Factura rechazada | La orden vuelve a `PAID` (comportamiento actual) y el stock sigue apartado: el producto ya se entregó |
| Permisos | Vender pide `billing.create`. Nuevo `inventory.manage` para catálogo, entradas, ajustes, traslados, costos y reportes: por defecto en MASTER, concedible a PROFESIONAL y ASISTENTE |
| Costos visibles | Solo con `inventory.manage`. La caja ve precio y disponible, nunca costo |
| Sección | Nueva subsección `core.billing.inventory` («Inventario»), que requiere `core.billing.orders` |

## Modelo de datos

Migración aditiva `20261026000000_product_inventory`. Todos los modelos nuevos llevan `tenantId`
con índice y las mismas políticas RLS que las tablas de la caja. Dinero en `Decimal(10,2)`,
tarifas en `Decimal(5,2)`, unidades en `Int`. No hay borrado físico de productos, lotes,
recepciones, traslados ni movimientos.

### `Product`

| Campo | Contenido |
|---|---|
| `code` | Mayúsculas, recortado. `@@unique([tenantId, code])`; además no puede coincidir con un `Treatment.code` del tenant |
| `name` | `@@unique([tenantId, name])` |
| `category?` | Texto libre |
| `barcode?` | Para buscar con un lector USB. Índice único parcial `(tenantId, barcode) WHERE barcode IS NOT NULL` en la migración |
| `price` | Precio de venta sin IVA, mayor que 0 |
| `taxRatePercent` | 0, 5 o 15 (`SUPPORTED_FREE_TAX_RATES`) |
| `tracksExpiry` | Si sus lotes exigen vencimiento. No cambia una vez que el producto tiene lotes |
| `minStock` | Entero ≥ 0, por defecto 0 (sin alerta) |
| `isActive` | Un producto inactivo no se vende; su stock sigue |
| `createdById`, `createdAt`, `updatedAt` | |

### `StockLot`

Unidades de un producto en una sede.

| Campo | Contenido |
|---|---|
| `productId`, `branchId` | |
| `lotNumber?` | Número del fabricante |
| `expiresAt?` | `@db.Date`. Obligatorio si `tracksExpiry` |
| `unitCost` | Costo unitario sin IVA, ≥ 0 |
| `quantityReceived` | Unidades con que se creó el lote |
| `quantityOnHand` | Saldo disponible. `CHECK ("quantityOnHand" >= 0)` en la migración |
| `receiptId?` | La recepción que lo creó |
| `sourceLotId?` | El lote de origen cuando llegó por traslado |
| `receivedAt` | Fecha de entrada; desempate de FEFO |

Índices: `(tenantId, productId, branchId)` y `(tenantId, branchId, expiresAt)`.

### `StockReceipt`

Una compra que llega a una sede: `branchId`, `supplierName?`, `documentNumber?` (la factura del
proveedor), `receivedAt`, `note?`, `createdById`. Cada línea crea un `StockLot`. No se edita.

### `StockTransfer`

Traslado inmediato entre dos sedes, sin estado intermedio: `fromBranchId`, `toBranchId`, `note?`,
`createdById`, `createdAt`. Por cada lote de origen crea un lote en el destino con el mismo
`lotNumber`, `expiresAt` y `unitCost`, y `sourceLotId` apuntando al de origen.

### `StockMovement`

Registro que no se modifica. Para cada lote, la suma de `quantity` de sus movimientos es igual a su
`quantityOnHand`.

| Campo | Contenido |
|---|---|
| `kind` | `RECEIPT`, `SALE`, `SALE_RELEASE`, `ADJUSTMENT`, `TRANSFER_OUT`, `TRANSFER_IN` |
| `productId`, `branchId`, `lotId` | |
| `quantity` | Entero con signo, distinto de 0 |
| `unitCost` | El del lote, copiado |
| `adjustmentReason?` | `COUNT`, `DAMAGE`, `EXPIRED`, `INTERNAL_USE`, `OTHER`; solo en `ADJUSTMENT` |
| `note?` | Obligatoria con `OTHER` |
| `receiptId?`, `transferId?`, `orderItemId?` | Lo que originó el movimiento |
| `createdById`, `createdAt` | |

Índices: `(tenantId, productId, createdAt)`, `(tenantId, branchId, createdAt)`, `(lotId)`.

### Cambios en la caja

- `OrderItemKind` gana `PRODUCT`.
- `OrderItem` gana `productId?` (relación `Restrict`).
- Nuevo `OrderItemLot`: `orderItemId`, `lotId`, `quantity` (entero > 0), `unitCost`. Dice de qué
  lotes salió cada línea; sirve para devolver las unidades al mismo lote y para el margen.
- `AuditEntity` gana `PRODUCT`, `STOCK_RECEIPT`, `STOCK_ADJUSTMENT` y `STOCK_TRANSFER`.

### Secciones y permisos

- `core.billing.inventory` entra en `SECTION_KEYS` y en el catálogo con `parent: 'core.billing'` y
  `requires: ['core.billing.orders']`.
- La migración agrega una fila de `PlanModule` por cada plan que ya tiene `core.billing.orders`, y
  una fila de `TenantModule` (origen `PLAN`) por cada consultorio cuyo plan la recibe, siguiendo
  `20261024000000_module_catalog`.
- `inventory.manage` entra en `PERMISSION_CATALOG` con `roles: ['MASTER']` y
  `grantable: ['PROFESIONAL', 'ASISTENTE']`.

## Reglas

### Vender

- `POST /orders/:id/items` acepta `{ version, kind: 'PRODUCT', productId, quantity, discount? }`.
  `quantity` es entero ≥ 1 (`422 ORDER_LINE_INVALID` si no). Sin `core.billing.inventory`
  responde `403 SECTION_NOT_ENABLED`.
- No exige `billing.adjust`: precio e IVA salen del producto, como en las sesiones. Un descuento sí
  lo exige, como hoy.
- La orden debe estar editable (`409 ORDER_NOT_EDITABLE`, regla actual). El producto debe existir
  en el tenant (`404 PRODUCT_NOT_FOUND`) y estar activo (`409 PRODUCT_INACTIVE`).
- **Asignación**, dentro de la transacción serializable de la orden:
  1. Lee los lotes del producto en la sede de la orden con `quantityOnHand > 0` y
     (`expiresAt` nulo o `expiresAt ≥` hoy en la zona horaria del consultorio), ordenados por
     `expiresAt` ascendente con nulos al final y luego por `receivedAt`.
  2. Toma de cada lote lo que falte hasta cubrir `quantity`. Si la suma no alcanza responde
     `409 INSUFFICIENT_STOCK` con `{ available }` y no aparta nada.
  3. Descuenta cada lote con `updateMany({ where: { id, quantityOnHand: { gte: n } } })`; si
     alguno devuelve `count = 0`, otra transacción ganó: responde `409 INSUFFICIENT_STOCK`.
  4. Crea el `OrderItem` (precio, IVA, descripción = nombre del producto), sus `OrderItemLot` y un
     movimiento `SALE` (cantidad negativa) por lote.
- La lógica de los pasos 1–2 es una función pura en `api/src/inventory/fefo.ts`, como
  `order-totals.ts`.
- **Quitar la línea** (`DELETE /orders/:id/items/:itemId`, reglas actuales) y **cancelar la orden**
  (que hoy marca `releasedAt`) devuelven cada `OrderItemLot` a su lote con un movimiento
  `SALE_RELEASE`. Se devuelve aunque el lote haya vencido mientras tanto; queda como vencido y
  aparece en el reporte.
- Reembolsar un pago no mueve stock. Para devolver un producto antes de facturar: reembolsar los
  pagos (la orden vuelve a `OPEN`) y quitar la línea.

### Catálogo

- Crear y editar productos exige `inventory.manage`. `code` repetido en productos o en tratamientos
  responde `409 PRODUCT_CODE_TAKEN`; `TreatmentsService` responde `409 TREATMENT_CODE_TAKEN` cuando
  el código ya es de un producto. `name` repetido: `409 PRODUCT_NAME_TAKEN`. `barcode` repetido:
  `409 PRODUCT_BARCODE_TAKEN`.
- `taxRatePercent` fuera de 0, 5 o 15: `422 TAX_RATE_UNSUPPORTED`.
- Cambiar `tracksExpiry` cuando el producto tiene lotes: `409 PRODUCT_HAS_STOCK`.
- Cambiar precio o IVA no afecta líneas ya agregadas.

### Entradas

- `POST /stock-receipts` con `{ branchId, supplierName?, documentNumber?, receivedAt?, note?, lines:
  [{ productId, quantity, unitCost, lotNumber?, expiresAt? }] }`, al menos una línea.
- La sede debe estar activa (`assertBranchAvailable`: `400 BRANCH_NOT_AVAILABLE`). Cada producto,
  activo (`409 PRODUCT_INACTIVE`).
- `expiresAt` falta en un producto con `tracksExpiry`: `422 LOT_EXPIRY_REQUIRED`. Fecha pasada:
  `422 LOT_ALREADY_EXPIRED`.
- Crea la recepción, un lote por línea y un movimiento `RECEIPT` por lote.

### Ajustes

- `POST /stock-lots/:id/adjustments` con `{ delta } | { countedQuantity }`, `reason` y `note?`
  (obligatoria con `OTHER`). `countedQuantity` se convierte en `delta = counted − onHand`.
  `delta = 0`: `422 ADJUSTMENT_EMPTY`.
- Si el lote quedaría negativo: `422 STOCK_BELOW_ZERO`.
- Escribe un movimiento `ADJUSTMENT`.

### Traslados

- `POST /stock-transfers` con `{ fromBranchId, toBranchId, note?, lines: [{ lotId, quantity }] }`.
- Sedes distintas (`422 TRANSFER_SAME_BRANCH`) y activas (`400 BRANCH_NOT_AVAILABLE`). Cada lote debe estar en la sede de origen
  (`422 LOT_NOT_IN_BRANCH`) y tener saldo suficiente (`409 INSUFFICIENT_STOCK`). Lo apartado en
  órdenes abiertas ya no está en el saldo, así que no se puede trasladar.
- Por línea: movimiento `TRANSFER_OUT` en el lote de origen, lote nuevo en el destino y movimiento
  `TRANSFER_IN` en él.

### Auditoría

Cada comando escribe `AuditLog` con las entidades nuevas (`PRODUCT`, `STOCK_RECEIPT`,
`STOCK_ADJUSTMENT`, `STOCK_TRANSFER`); las ventas y liberaciones se auditan en la `ORDER`, como los
demás cambios de ítems. Ninguna es entidad clínica.

## Facturación

- En el snapshot fiscal, una línea `PRODUCT` lleva `code = product.code`, `localId = productId` y
  `name = orderItem.description`. Al crear la solicitud se lee el código actual del producto.
- `InvoiceResolver` no cambia: usa el código como SKU y, si el nombre o el IVA ya no coinciden con
  el producto de emite-facil, usa el SKU con hash.
- La regla de elegibilidad RN-10 (documentación del tratamiento) no se aplica a productos.

## Costo, margen y reportes

Todos exigen `inventory.manage`.

| Reporte | Contenido |
|---|---|
| Valorización | Por sede y producto: unidades y `Σ quantityOnHand × unitCost` |
| Por vencer | Lotes con saldo que vencen en los próximos N días (30, 60 o 90) y los ya vencidos |
| Bajo mínimo | Producto y sede con disponible no vencido menor que `minStock` |
| Margen | Por período y sede: venta neta (`lineSubtotal`) menos costo (`Σ OrderItemLot.quantity × unitCost`) de líneas en órdenes `PAID` o `INVOICED` |

## API

Módulo nuevo `api/src/inventory/`, con un servicio por responsabilidad: `products.service.ts`,
`stock-allocation.service.ts` (FEFO, apartar y liberar; lo usa `OrdersService`),
`stock-receipts.service.ts`, `stock-adjustments.service.ts`, `stock-transfers.service.ts` e
`inventory-reports.service.ts`. Rutas bajo `/tenants/:tenantId`, con el guard de sección
`core.billing.inventory`.

| Ruta | Permiso | Notas |
|---|---|---|
| `GET /products?search=&barcode=&branchId=&active=` | `billing.create` o `inventory.manage` | Disponible no vencido por sede. Sin costo |
| `GET /products/:id` | `billing.create` o `inventory.manage` | Con `inventory.manage`, incluye lotes y costos |
| `POST /products`, `PATCH /products/:id` | `inventory.manage` | |
| `PATCH /products/:id/active` | `inventory.manage` | `{ isActive }` |
| `GET /products/:id/lots?branchId=` | `inventory.manage` | |
| `GET /stock-movements?productId=&branchId=&kind=&from=&to=` | `inventory.manage` | Paginado |
| `POST /stock-receipts`, `GET /stock-receipts`, `GET /stock-receipts/:id` | `inventory.manage` | |
| `POST /stock-lots/:id/adjustments` | `inventory.manage` | |
| `POST /stock-transfers`, `GET /stock-transfers`, `GET /stock-transfers/:id` | `inventory.manage` | |
| `GET /inventory/reports/valuation?branchId=` | `inventory.manage` | |
| `GET /inventory/reports/expiring?days=&branchId=` | `inventory.manage` | |
| `GET /inventory/reports/low-stock?branchId=` | `inventory.manage` | |
| `GET /inventory/reports/margin?from=&to=&branchId=` | `inventory.manage` | Período de hasta un año |

En `orders/`: `AddOrderItemDto` acepta `PRODUCT` y `productId`; `OrdersService.addItem`,
`removeItem` y `cancel` llaman a `StockAllocationService` dentro de su transacción; `order-view.ts`
expone `productId` en la línea.

## Web

- **Orden de caja** (`/cash/orders/[id]`): botón «Agregar producto», visible con
  `core.billing.inventory` y `billing.create`. Abre un buscador por nombre, código o código de
  barras (un lector USB escribe el código y Enter lo agrega), muestra el disponible de la sede de la
  orden y pide la cantidad. Muestra `INSUFFICIENT_STOCK` con el disponible devuelto.
- **`/inventory`**, en la barra lateral como «Inventario» con `core.billing.inventory` e
  `inventory.manage`. Pestañas:
  - Productos: catálogo, alta y edición, stock por sede y marca de bajo mínimo.
  - Entradas: lista y nueva recepción con varias líneas.
  - Ajustes y traslados: ajuste por lote desde el detalle del producto, y nuevo traslado.
  - Por vencer: 30, 60 o 90 días y vencidos.
  - Valorización y margen por período y sede.

## Seed

El Estudio Estético Aurora recibe tres productos (protector solar con vencimiento, sérum con
vencimiento, esponja sin vencimiento), una recepción en su sede principal con un lote de protector
que vence en 20 días y otro a seis meses, y un producto bajo su mínimo.

## Pruebas

API, unitarias:

- `fefo.ts`: orden por vencimiento con nulos al final, desempate por entrada, salta vencidos,
  reparte entre lotes, no aparta nada si no alcanza.
- `StockAllocationService`: `count = 0` en el descuento condicional responde `INSUFFICIENT_STOCK`;
  la liberación vuelve al mismo lote.
- Órdenes: agregar `PRODUCT` sin `billing.adjust`; descuento sí lo exige; quitar y cancelar
  devuelven stock; producto inactivo; sección deshabilitada.
- Catálogo: código repetido entre tratamientos y productos en los dos sentidos; `tracksExpiry` con
  lotes.
- Entradas, ajustes y traslados: cada error de la sección de reglas.
- Permisos: la caja con `billing.create` no ve costos; cada ruta con permiso solo abierta a roles
  que lo tienen (prueba de matriz existente).
- Snapshot fiscal: la línea `PRODUCT` lleva código y `localId` del producto.

API, e2e `test/inventory.e2e-spec.ts` contra `DATABASE_URL_TEST`:

1. Recepción en la sede Norte con dos lotes de distinto vencimiento.
2. Orden con 2 unidades que se reparten entre los dos lotes; pago; solicitud de factura con el
   código del producto.
3. Otra orden que se cancela y devuelve sus unidades.
4. Traslado a la sede Sur y ajuste por rotura.
5. Para cada lote, el saldo es igual a la suma de sus movimientos.
6. Concurrencia: dos órdenes piden la última unidad a la vez; una la obtiene, la otra recibe
   `409 INSUFFICIENT_STOCK`, y el saldo nunca queda negativo.
7. Aislamiento: otro tenant no ve ni vende los productos.

Web (Vitest): buscador y alta por código de barras; `INSUFFICIENT_STOCK` mostrado con el
disponible; formularios de producto, recepción, ajuste y traslado; las pestañas se ocultan sin
`inventory.manage`.

## Fuera de alcance

- Insumos que consume un tratamiento.
- Devoluciones después de facturar y notas de crédito.
- Proveedores como entidad y órdenes de compra.
- Traslados en tránsito o con recepción en destino.
- Stock mínimo distinto por sede.
- Impresión de etiquetas o códigos de barras, gaveta de dinero y datáfono.
- Venta de lotes vencidos.

## Entrega

- Ramas `feat/product-inventory` en `hcx-care-api` y en el cliente web, creadas desde `dev`; los PR
  van contra `dev`.
- La API pasa pruebas unitarias, e2e y build, y `prettier --check` en los archivos tocados (el lint
  está roto por T-15). La web pasa lint, type-check y Vitest.
- Al cerrar, se actualizan las filas §37–41 y §42–43 de `TAREAS_PENDIENTES.md`.
