# Planes, cobro y ciclo de vida de la suscripción

**Fecha:** 2026-10-28 · **Antes:** 2026-10-25, 2026-10-01 (T-05 y T-06)

## Decisión

Los planes viven en la base de datos (`Plan`, `PlanModule`) y **solo el `ADMIN` de la plataforma** los crea, edita y asigna. El consultorio no cambia su plan ni compra módulos: ve su plan, su uso y lo que debe, y paga por fuera.

No hay proveedor de cobro integrado. El cobro es **manual con aprobación explícita**: el consultorio paga (transferencia, depósito) y el `ADMIN` confirma el pago con su referencia. El punto de entrada queda listo para un proveedor: su webhook llamaría a `SubscriptionBillingService.confirmPayment` con `provider` propio y el identificador del evento como `reference`.

## Planes

Un plan tiene código (fijo), nombre, tipo de consultorio (`PERSONAL` o `CLINIC`), precio base, precio por profesional y por especialidad adicional, límites (profesionales, pacientes activos, GB, facturas electrónicas al mes, especialidades incluidas, sedes activas), días de prueba sugeridos y los módulos/submódulos del catálogo que incluye.

| Ruta | Uso |
| --- | --- |
| `GET /platform/plans` | Todos los planes, archivados incluidos, con cuántos consultorios lo usan |
| `POST /platform/plans` | Crea un plan (`409 PLAN_CODE_TAKEN`) |
| `PATCH /platform/plans/:planId` | Edita un plan: **todos sus consultorios toman los cambios al instante**, salvo lo ajustado en cada uno. `409 PLAN_IN_USE` al cambiar el tipo de un plan con consultorios |
| `POST /platform/plans/:planId/archive` · `/restore` | Un plan archivado conserva sus consultorios pero no se puede asignar (`409 PLAN_ARCHIVED`) |

Las ediciones se auditan en el tenant de la plataforma con la entidad `PLAN`.

### Catálogo vigente (`20261028000000_plan_ladder`)

Precios en USD al mes, más IVA.

| Código | Plan | Tipo | Precio | Profesionales | Profesional extra | Sedes | Comprobantes/mes | Pacientes activos | GB | Especialidades | Especialidad extra |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ESENCIAL` | Esencial | `PERSONAL` | 24,90 | 1 | — | 1 | 30 | 100 | 3 | 1 | 10 |
| `PROFESIONAL` | Profesional | `CLINIC` | 44,90 | 3 | 14 | 1 | 100 | 300 | 10 | 2 | 10 |
| `CENTRO` | Centro | `CLINIC` | 79,90 | 6 | 12 | 2 | 300 | 600 | 25 | 3 | 10 |
| `CLINICA` | Clínica | `CLINIC` | 149,90 | 15 | 10 | 5 | 1.000 | 1.500 | 60 | 5 | 10 |
| `CLINIC_ENTERPRISE` | Personalizado | `CLINIC` | A medida | 999 | — | 50 | 3.000 | Sin límite | 100 | Todas | 15 |

Los cuatro primeros tienen 14 días de prueba. Llenar un plan con profesionales extra cuesta más que el plan siguiente, que además trae más sedes y comprobantes.

`PERSONAL_BASIC`, `PERSONAL_PRO`, `CLINIC_BASIC` y `CLINIC_PRO` quedan archivados: sus consultorios los conservan con el mismo precio y límites, y con las sedes que ya podían tener (1 en un consultorio individual, 50 en una clínica). Pasarlos a un plan nuevo es un cambio de plan desde el panel.

### Sedes

`maxBranches` limita las sedes **activas**: crear una sede o reactivar una inactiva por encima del límite responde `409 BRANCH_LIMIT_REACHED` con `limit`. Desactivar una sede libera su lugar. Un consultorio `PERSONAL` trabaja con una sola sede, diga lo que diga su plan.

### Valores de cada consultorio

`TenantSubscription` guarda los valores vigentes (`basePrice`, `pricePerSeat`, `specialtyPrice`, `currency`, `seatsPsychologistsMax`, `maxActivePatients`, `storageGB`, `monthlyElectronicInvoicesLimit`, `includedSpecialties`, `maxBranches`); los bloqueos leen esas columnas. `overriddenFields` lista las que el `ADMIN` fijó para ese consultorio: editar el plan no las toca.

- `PUT /platform/tenants/:tenantId/subscription/overrides` — `{ values, reset?, reason }`: fija valores propios o los devuelve al plan.
- `PUT /platform/tenants/:tenantId/sections` — módulos del consultorio. Una fila que coincide con lo que da el plan queda `source = PLAN`; una que difiere, `OVERRIDE`, y sobrevive a las ediciones del plan.
- Los submódulos solo de salud quedan apagados por defecto si todas las especialidades del consultorio son estéticas.

Bajar un límite por debajo del uso actual no borra nada: el consultorio solo no puede crear más.

### Cambiar de plan

`PATCH /platform/tenants/:tenantId/subscription` — `{ planId, trialDays?, reason }`. El consultorio toma precio, límites y módulos del plan nuevo y **se descartan sus ajustes**. Con `trialDays` entra en prueba de ese plan; sin ellos paga desde hoy, o conserva un período pagado en curso. El alta de un consultorio (`POST /platform/tenants`) recibe `planId` y `trialDays` (por defecto, los del plan).

## Precio mensual

`basePrice` es el precio del plan (o el ajustado). Lo que se cobra cada mes es `basePrice + (especialidades − incluidas) × specialtyPrice` (`monthlyTotal` en `src/plans/plan-values.ts`). Cambiar especialidades ya no reescribe `basePrice`.

## Pagos (`SubscriptionPayment`)

| Tipo | Lo crea | Efecto al confirmarse |
| --- | --- | --- |
| `RENEWAL` | El proceso programado, 7 días antes del fin del período o de la prueba | Fija el período que cubre y deja la suscripción `ACTIVE` |
| `PLAN_UPGRADE` | Ya no se crea; queda en el historial | `409 PAYMENT_NO_LONGER_APPLICABLE` |

Cada pago guarda `planId` y `planName` (el nombre del plan cuando se cobró). Estados: `PENDING` → `CONFIRMED` · `REJECTED` · `CANCELED` · `EXPIRED`.

| Ruta | Rol | Uso |
| --- | --- | --- |
| `GET /tenants/:tenantId/subscription/payments` | MASTER | Pagos del consultorio, incluidos los pendientes |
| `GET /platform/subscription-payments?status=PENDING` | ADMIN | Pagos de todos los consultorios |
| `POST /platform/subscription-payments/:paymentId/confirm` | ADMIN | `{ reference, note? }` — aplica el pago |
| `POST /platform/subscription-payments/:paymentId/reject` | ADMIN | `{ reason }` — cierra el cobro sin cambios |

### Idempotencia

- Confirmar dos veces con la misma referencia devuelve `alreadyConfirmed: true` y no vuelve a tocar la suscripción.
- Una referencia confirma un solo pago: índice único `(provider, providerReference)`; el segundo intento responde `409 PAYMENT_REFERENCE_ALREADY_USED`.
- Un pago que no está `PENDING` responde `409 PAYMENT_NOT_PENDING`.
- La confirmación corre en una transacción serializable.

## Proceso programado

`SubscriptionLifecycleService` se ejecuta cada hora y hace, en este orden:

1. **Cobros.** Emite un `RENEWAL` por consultorio y período, al precio vigente: 7 días antes del fin de un período pagado, o del fin de una prueba (el primer mes del plan).
2. **Fin de prueba o de período sin pago** → `PAST_DUE` (solo lectura).
3. **7 días después** → `UNPAID` (acceso bloqueado).

Cada paso reclama su fila con una actualización condicional (o un índice único): repetir la ejecución, o correrla en dos instancias, no aplica nada dos veces. Los planes con precio 0 (el personalizado) no vencen solos. Un consultorio `PAST_DUE` o `UNPAID` sigue viendo su suscripción (`@AllowInactiveSubscription`). Los plazos están en `BILLING_RULES` (`src/subscription/subscription-billing.rules.ts`).

## Migración (`20261025000000_editable_plans`)

Crea los cinco planes que el código definía (los mismos valores que `src/plans/default-plans.ts`, con ids `plan_<código>`) y conserva lo que cada consultorio tenía:

- Una prueba pasa a días de prueba del plan básico de su tipo, con sus límites.
- `basePrice` deja de incluir las especialidades extra; lo que difiere del plan (módulos comprados, límites propios) queda en `overriddenFields`.
- Las filas de módulos que difieren de lo que da el plan quedan `OVERRIDE`.
- Las mejoras pendientes de pago se cancelan; los eventos conservan los códigos de plan.
- Se eliminan el enum `PlanType`, los 15 `feature*`, `scheduledPlanChange*` y `PlanSpecialty`.

## Lo que no cubre

- **Sitio público de precios:** es estático (`web/src/content/site.ts`) y no lee los planes de la base; copia el catálogo vigente de arriba.
- **Comprobantes adicionales:** no hay paquetes; un consultorio que necesita más sin cambiar de plan recibe un ajuste de `monthlyElectronicInvoicesLimit`.
- **Avisos al consultorio** (cobro emitido, pago confirmado, vencimiento): dependen del servicio de correo (T-07).
- **Instrucciones de pago:** la web muestra un texto genérico.
- **Facturación anual:** no existe.
