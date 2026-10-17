import { HttpException } from '@nestjs/common';
const messages: Record<string, string> = {
  INVOICING_API_KEY_REQUIRED: 'Ingresa una API key de emite-facil para configurar la conexión.',
  INVOICING_ENCRYPTION_REQUIRED:
    'El servidor necesita configurar el cifrado antes de guardar datos de facturación.',
  INVOICING_CONFIGURATION_CHANGED:
    'La configuración cambió durante la validación. Actualiza los datos e intenta guardar nuevamente.',
  INVOICING_TAXPAYER_INVALID: 'Selecciona un emisor válido de esta conexión.',
  INVOICING_TENANT_INACTIVE: 'La empresa está suspendida en emite-facil.',
  INVOICING_IDENTITY_LOCKED:
    'La empresa y el emisor no pueden cambiar después de solicitar una factura. Puedes rotar la API key del mismo emisor.',
  INVOICING_ENVIRONMENT_BUSY:
    'Finaliza la conciliación y las descargas pendientes antes de cambiar el ambiente del emisor.',
  INVOICING_ENVIRONMENT_CHANGED:
    'El ambiente del emisor cambió en emite-facil. Revisa la configuración antes de continuar.',
  INVOICING_POINT_INVALID:
    'El establecimiento o punto de emisión no pertenece al emisor seleccionado o está deshabilitado.',
  INVOICING_DISABLED: 'La conexión de facturación está desactivada.',
  INVOICING_WEBHOOK_RETRY: 'No se pudo procesar la notificación. Se requiere un nuevo intento.',
  INVOICE_LIMIT_REACHED: 'Alcanzaste el límite mensual de facturas de tu plan.',
  INVOICE_RECONCILIATION_REQUIRED:
    'La emisión anterior tiene un resultado incierto. Espera su conciliación antes de volver a emitir o devolver pagos.',
  INVOICE_REQUEST_IN_PROGRESS: 'La orden ya tiene una solicitud de factura en curso.',
  INVOICE_REPLACEMENT_ENVIRONMENT_MISMATCH:
    'El comprobante rechazado pertenece a otro ambiente. Revisa la configuración antes de reemplazarlo.',
  INVOICE_REQUEST_NOT_FOUND: 'No se encontró la solicitud de factura.',
  INVOICE_ARTIFACT_NOT_READY:
    'El archivo todavía no está disponible. Su descarga se volverá a intentar automáticamente.',
  INVOICE_ARTIFACT_INTEGRITY: 'No se pudo verificar la integridad del archivo de la factura.',
  INVOICE_BODY_INTEGRITY:
    'No se pudo verificar la solicitud fiscal guardada. Requiere revisión antes de continuar.',
  INVOICE_DOCUMENT_MISMATCH:
    'El documento recibido no corresponde al emisor y ambiente de esta solicitud.',
  ORDER_ALREADY_AUTHORIZED:
    'La orden ya tiene una factura autorizada y no puede volver a emitirse desde HCX.',
  ORDER_NOT_BILLABLE:
    'La orden debe estar pagada y cumplir los requisitos para emitir una factura.',
  ORDER_NOT_FOUND: 'No se encontró la orden.',
  BRANCH_NOT_FOUND: 'No se encontró la sede.',
  PAYMENT_TOTAL_MISMATCH: 'Los pagos registrados deben sumar exactamente el total de la factura.',
  IDEMPOTENCY_KEY_INVALID:
    'La clave de la solicitud no es válida. Actualiza la página e intenta nuevamente.',
  IDEMPOTENCY_KEY_REUSED:
    'La clave de solicitud ya está en uso. Si la emisión es incierta, espera su conciliación.',
  CUSTOMER_SYNC_REQUIRED:
    'Los datos fiscales del receptor difieren de emite-facil. Corrígelos allí antes de volver a emitir.',
  PRODUCT_SYNC_REQUIRED:
    'La descripción o impuesto del producto difiere de emite-facil. Revisa el catálogo antes de volver a emitir.',
  CUSTOMER_SYNC_PENDING:
    'La sincronización del receptor está pendiente. Se volverá a intentar automáticamente.',
  PRODUCT_SYNC_PENDING:
    'La sincronización del producto está pendiente. Se volverá a intentar automáticamente.',
  TAX_RATE_UNSUPPORTED:
    'La tarifa de impuesto de la orden no está disponible en el catálogo de emite-facil.',
  SIGNATURE_FAILED:
    'Corrige la firma en emite-facil y reintenta el mismo documento allí. HCX seguirá consultando su estado.',
  SRI_REJECTED:
    'El comprobante fue rechazado. Revisa la explicación del SRI, corrige los datos y solicita un reemplazo.',
  UNAUTHENTICATED: 'La API key no es válida o fue revocada. Revisa la conexión con emite-facil.',
  ROLE_FORBIDDEN: 'La API key no tiene permisos para esta operación en emite-facil.',
  RATE_LIMITED:
    'emite-facil limitó temporalmente las solicitudes. Se volverá a intentar automáticamente.',
  INVALID_RESPONSE:
    'emite-facil devolvió una respuesta que no se pudo verificar. Se volverá a intentar automáticamente.',
  TIMEOUT: 'emite-facil no respondió a tiempo. Se conservará la misma solicitud para conciliarla.',
  TRANSPORT_ERROR:
    'No se pudo conectar con emite-facil. Se volverá a intentar con la misma solicitud.',
};
export function invoiceMessage(code: string): string {
  return messages[code] ?? 'No se pudo completar la operación de facturación. Intenta nuevamente.';
}
export function invoiceError(code: string, status = 409): HttpException {
  return new HttpException({ statusCode: status, code, message: invoiceMessage(code) }, status);
}
