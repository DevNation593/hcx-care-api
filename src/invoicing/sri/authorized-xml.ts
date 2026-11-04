export interface AuthorizedXmlInput {
  signedXml: string;
  authorizationNumber: string;
  authorizedAt: Date;
  environmentLabel: 'PRUEBAS' | 'PRODUCCIÓN';
}

/** Ecuador has no daylight saving time, so its civil time is always UTC-5. */
const ECUADOR_OFFSET_MS = -5 * 60 * 60 * 1000;

function ecuadorTimestamp(date: Date): string {
  const shifted = new Date(date.getTime() + ECUADOR_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 19)}-05:00`;
}

/**
 * Authorized XML delivered to the recipient: the SRI authorization data wrapping the signed
 * voucher exactly as it was sent. The voucher goes in a CDATA section so its bytes, and with them
 * its signature, do not change.
 */
export function buildAuthorizedXml(input: AuthorizedXmlInput): string {
  if (!/^[0-9]{10,49}$/.test(input.authorizationNumber)) {
    throw new Error('Invalid authorization number');
  }
  if (Number.isNaN(input.authorizedAt.getTime())) throw new Error('Invalid authorization date');
  if (!input.signedXml) throw new Error('Missing signed XML');
  // "]]>" cannot appear inside a CDATA section: it is split across two contiguous sections.
  const voucher = input.signedXml.replace(/\]\]>/g, ']]]]><![CDATA[>');
  return (
    '<?xml version="1.0" encoding="UTF-8"?><autorizacion><estado>AUTORIZADO</estado>' +
    `<numeroAutorizacion>${input.authorizationNumber}</numeroAutorizacion>` +
    `<fechaAutorizacion>${ecuadorTimestamp(input.authorizedAt)}</fechaAutorizacion>` +
    `<ambiente>${input.environmentLabel}</ambiente>` +
    `<comprobante><![CDATA[${voucher}]]></comprobante></autorizacion>`
  );
}
