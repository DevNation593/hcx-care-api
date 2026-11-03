import { HttpException } from '@nestjs/common';
const messages: Record<string, string> = {
  INVOICING_ENCRYPTION_REQUIRED:
    'El servidor necesita configurar el cifrado antes de guardar datos de facturación.',
  INVOICING_CONFIGURATION_CHANGED:
    'La configuración cambió durante la validación. Actualiza los datos e intenta guardar nuevamente.',
  INVOICING_IDENTITY_LOCKED:
    'El RUC del emisor no puede cambiar después de solicitar una factura. Puedes actualizar sus demás datos.',
  INVOICING_ENVIRONMENT_BUSY:
    'Espera a que terminen las facturas en proceso y la descarga de sus archivos antes de cambiar el ambiente del emisor.',
  INVOICING_ENVIRONMENT_CHANGED:
    'El ambiente del emisor cambió después de solicitar la factura. Revisa la configuración y solicítala nuevamente.',
  INVOICING_NOT_CONFIGURED:
    'Configura el emisor, su firma electrónica y el punto de emisión de la sede antes de facturar.',
  INVOICING_CERTIFICATE_REQUIRED: 'Sube la firma electrónica (.p12) del emisor con su contraseña.',
  CERTIFICATE_PASSWORD_INVALID: 'La contraseña de la firma electrónica no es correcta.',
  CERTIFICATE_UNREADABLE:
    'No se pudo leer la firma electrónica. Sube el archivo .p12 o .pfx que entregó la entidad certificadora.',
  CERTIFICATE_EXPIRED: 'La firma electrónica está vencida. Renuévala y súbela nuevamente.',
  CERTIFICATE_NOT_YET_VALID:
    'La firma electrónica todavía no está vigente. Revisa su fecha de inicio de validez.',
  CERTIFICATE_NO_RSA_KEY:
    'La firma electrónica no contiene una clave privada RSA utilizable para firmar comprobantes.',
  CERTIFICATE_KEY_MISMATCH:
    'La clave privada de la firma electrónica no corresponde a su certificado. Solicita un archivo válido a la entidad certificadora.',
  CERTIFICATE_RUC_MISMATCH: 'La firma electrónica pertenece a otro RUC distinto al del emisor.',
  INVOICING_RUC_INVALID: 'El RUC del emisor no es válido. Revisa los dígitos.',
  RIMPE_REGIME_UNSUPPORTED:
    'El régimen RIMPE Negocio Popular aún no está disponible para facturación electrónica.',
  INVOICING_SERIES_TAKEN:
    'Ese establecimiento y punto de emisión ya están asignados a otra sede. Usa una serie distinta.',
  INVOICING_SEQUENCE_BACKWARDS:
    'El siguiente secuencial no puede ser menor que el actual: el SRI rechazaría números repetidos.',
  INVOICE_LIMIT_REACHED: 'Alcanzaste el límite mensual de facturas de tu plan.',
  INVOICE_REQUEST_IN_PROGRESS: 'La orden ya tiene una solicitud de factura en curso.',
  INVOICE_REQUEST_NOT_FOUND: 'No se encontró la solicitud de factura.',
  INVOICE_ARTIFACT_NOT_READY:
    'El archivo todavía no está disponible. Su descarga se volverá a intentar automáticamente.',
  INVOICE_ARTIFACT_INTEGRITY: 'No se pudo verificar la integridad del archivo de la factura.',
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
  TAX_RATE_UNSUPPORTED:
    'La tarifa de impuesto de la orden no está disponible en el catálogo del SRI.',
  INVOICE_LINE_INVALID:
    'Una línea de la orden tiene cantidad, precio o descuento no válidos para la factura.',
  FINAL_CONSUMER_LIMIT:
    'El total supera el máximo permitido para facturar a consumidor final. Registra los datos del cliente.',
  SRI_REJECTED:
    'El comprobante fue rechazado. Revisa la explicación del SRI, corrige los datos y solicita un reemplazo.',
  SRI_UNAVAILABLE:
    'Los servicios del SRI no están disponibles. Se volverá a intentar automáticamente.',
  SRI_TIMEOUT:
    'El SRI no respondió a tiempo. Se volverá a consultar el mismo comprobante automáticamente.',
  SRI_INVALID_RESPONSE:
    'El SRI devolvió una respuesta que no se pudo interpretar. Se volverá a intentar automáticamente.',
  INVOICE_SIGNATURE_INVALID:
    'No se pudo verificar la firma del comprobante. Revisa la firma electrónica del emisor y solicita la factura nuevamente.',
  INVOICE_SIGNED_XML_UNAVAILABLE:
    'No se pudo leer el comprobante firmado guardado. Se volverá a intentar automáticamente.',
  INVOICE_SIGNED_XML_INTEGRITY:
    'No se pudo verificar el comprobante firmado guardado. Requiere revisión antes de volver a enviarlo al SRI.',
};
export function invoiceMessage(code: string): string {
  return messages[code] ?? 'No se pudo completar la operación de facturación. Intenta nuevamente.';
}
export function invoiceError(code: string, status = 409): HttpException {
  return new HttpException({ statusCode: status, code, message: invoiceMessage(code) }, status);
}
