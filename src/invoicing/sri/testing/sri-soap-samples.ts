import { SriMessage } from '../sri-types';

/**
 * SOAP responses shaped like the examples in section 7.2.3 of the SRI technical sheet v2.34,
 * parameterised by access key. Ported from the Java SriSoapSamples.
 */
export const AUTHORIZATION_DATE = '2012-03-05T16:57:34.997-05:00';

function messageXml(m: SriMessage): string {
  return (
    `<mensaje><identificador>${m.identifier}</identificador><mensaje>${m.message}</mensaje>` +
    (m.additionalInfo === null
      ? ''
      : `<informacionAdicional>${m.additionalInfo}</informacionAdicional>`) +
    `<tipo>${m.type}</tipo></mensaje>`
  );
}

function envelope(body: string): string {
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

function reception(content: string): string {
  return envelope(
    '<ns2:validarComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.recepcion">' +
      `<RespuestaRecepcionComprobante>${content}</RespuestaRecepcionComprobante>` +
      '</ns2:validarComprobanteResponse>',
  );
}

export function received(): string {
  return reception('<estado>RECIBIDA</estado><comprobantes/>');
}

export function returned(accessKey: string, ...messages: SriMessage[]): string {
  return reception(
    `<estado>DEVUELTA</estado><comprobantes><comprobante><claveAcceso>${accessKey}</claveAcceso>` +
      `<mensajes>${messages.map(messageXml).join('')}</mensajes></comprobante></comprobantes>`,
  );
}

/** Reception response with an arbitrary state, for cases the contract does not foresee. */
export function receptionWithState(state: string): string {
  return reception(`<estado>${state}</estado><comprobantes/>`);
}

/** One `autorizacion` element. Null data is omitted. */
export function autorizacion(
  state: string,
  number: string | null,
  date: string | null,
  environment: string | null,
  ...messages: SriMessage[]
): string {
  return (
    `<autorizacion><estado>${state}</estado>` +
    (number === null ? '' : `<numeroAutorizacion> ${number} </numeroAutorizacion>`) +
    (date === null ? '' : `<fechaAutorizacion>${date}</fechaAutorizacion>`) +
    (environment === null ? '' : `<ambiente>${environment}</ambiente>`) +
    '<comprobante><![CDATA[<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"></factura>]]></comprobante>' +
    `<mensajes>${messages.map(messageXml).join('')}</mensajes></autorizacion>`
  );
}

export function authorizations(consultedAccessKey: string, ...items: string[]): string {
  return envelope(
    '<ns2:autorizacionComprobanteResponse xmlns:ns2="http://ec.gob.sri.ws.autorizacion">' +
      `<RespuestaAutorizacionComprobante><claveAccesoConsultada> ${consultedAccessKey} </claveAccesoConsultada>` +
      `<numeroComprobantes>${items.length}</numeroComprobantes>` +
      (items.length === 0
        ? '<autorizaciones/>'
        : `<autorizaciones>${items.join('')}</autorizaciones>`) +
      '</RespuestaAutorizacionComprobante></ns2:autorizacionComprobanteResponse>',
  );
}

/** Authorized voucher with the warning 60 the SRI adds in the test environment. */
export function authorized(accessKey: string, environment = 'PRUEBAS'): string {
  return authorizations(
    accessKey,
    autorizacion('AUTORIZADO', accessKey, AUTHORIZATION_DATE, environment, {
      identifier: '60',
      message: 'ESTE PROCESO FUE REALIZADO EN EL AMBIENTE DE PRUEBAS',
      additionalInfo: null,
      type: 'ADVERTENCIA',
    }),
  );
}

export function notAuthorized(accessKey: string, state: string, ...messages: SriMessage[]): string {
  return authorizations(
    accessKey,
    autorizacion(state, null, '2012-02-13T16:34:48.997-05:00', 'PRUEBAS', ...messages),
  );
}

export function processing(accessKey: string): string {
  return authorizations(accessKey, autorizacion('EN PROCESO', null, null, 'PRUEBAS'));
}

export function fault(): string {
  return envelope(
    '<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Error interno</faultstring></soap:Fault>',
  );
}
