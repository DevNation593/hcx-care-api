import { Element as XmlElement, Node as XmlNode } from '@xmldom/xmldom';
import { parseXml } from './c14n';
import { SriEnvironment, SriError, SriMessage } from './sri-types';

export interface ReceptionResult {
  outcome: 'RECEIVED' | 'RETURNED';
  sriStatus: string;
  messages: SriMessage[];
}

/** A call may be given less time than the client default, e.g. to fit an inline budget. */
export interface SriCallOptions {
  timeoutMs?: number;
}

export interface AuthorizationResult {
  outcome: 'AUTHORIZED' | 'NOT_AUTHORIZED' | 'PENDING';
  sriStatus: string | null;
  authorizationNumber: string | null;
  authorizedAt: Date | null;
  environmentLabel: string | null;
  messages: SriMessage[];
}

const PATH = '/comprobantes-electronicos-ws/';
const RECEPTION_PATH = `${PATH}RecepcionComprobantesOffline`;
const AUTHORIZATION_PATH = `${PATH}AutorizacionComprobantesOffline`;

export const SRI_ENDPOINTS: Record<SriEnvironment, { reception: string; authorization: string }> = {
  '1': {
    reception: `https://celcer.sri.gob.ec${RECEPTION_PATH}`,
    authorization: `https://celcer.sri.gob.ec${AUTHORIZATION_PATH}`,
  },
  '2': {
    reception: `https://cel.sri.gob.ec${RECEPTION_PATH}`,
    authorization: `https://cel.sri.gob.ec${AUTHORIZATION_PATH}`,
  },
};

const RECEPTION_NS = 'http://ec.gob.sri.ws.recepcion';
const AUTHORIZATION_NS = 'http://ec.gob.sri.ws.autorizacion';
const ACCESS_KEY = /^[0-9]{49}$/;
const AUTHORIZATION_NUMBER = /^[0-9]{10,49}$/;

/** An authorization carries the voucher (320 KB at most), so 2 MB is generous. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 100;
const MAX_TEXT = 2000;
const MAX_STATUS = 60;

function soapEnvelope(namespace: string, body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="${namespace}">` +
    `<soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`
  );
}

export function hasMessage(r: { messages: SriMessage[] }, identifier: string): boolean {
  return r.messages.some((m) => m.identifier === identifier);
}

function elementChildren(parent: XmlElement, localName: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== XmlNode.ELEMENT_NODE) continue;
    const element = node as XmlElement;
    if ((element.localName ?? element.tagName) === localName) found.push(element);
  }
  return found;
}

/** Trimmed text of the first child with that local name; null when missing or empty. */
function childText(parent: XmlElement, localName: string): string | null {
  const [element] = elementChildren(parent, localName);
  const value = element?.textContent?.trim();
  return value ? value : null;
}

function bounded(value: string | null, max: number): string | null {
  return value === null || value.length <= max ? value : value.slice(0, max);
}

function readMessages(parent: XmlElement): SriMessage[] {
  const [list] = elementChildren(parent, 'mensajes');
  if (!list) return [];
  return elementChildren(list, 'mensaje')
    .slice(0, MAX_MESSAGES)
    .map((m) => ({
      identifier: bounded(childText(m, 'identificador'), 20),
      message: bounded(childText(m, 'mensaje'), MAX_TEXT),
      additionalInfo: bounded(childText(m, 'informacionAdicional'), MAX_TEXT),
      type: bounded(childText(m, 'tipo'), 30),
    }));
}

/** SRI dates carry an offset; without one they are Ecuador time (UTC-5). */
function parseSriDate(text: string | null): Date | null {
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!match) return null;
  const date = new Date(`${match[1]}${match[2] ?? '-05:00'}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function invalidResponse(): SriError {
  return new SriError('transient', 'SRI_INVALID_RESPONSE');
}

/**
 * Parses a SOAP response and returns the single element with that local name. parseXml refuses
 * DOCTYPE and entities and throws on malformed input; SOAP faults are unreadable by contract.
 */
function responseElement(body: string, localName: string): XmlElement {
  let document;
  try {
    document = parseXml(body);
  } catch {
    throw invalidResponse();
  }
  if (document.getElementsByTagNameNS('*', 'Fault').length > 0) throw invalidResponse();
  const found = document.getElementsByTagNameNS('*', localName);
  if (found.length !== 1) throw invalidResponse();
  return found.item(0) as XmlElement;
}

function parseReception(body: string): ReceptionResult {
  const response = responseElement(body, 'RespuestaRecepcionComprobante');
  const status = childText(response, 'estado');
  const messages: SriMessage[] = [];
  const [vouchers] = elementChildren(response, 'comprobantes');
  if (vouchers) {
    for (const voucher of elementChildren(vouchers, 'comprobante')) {
      messages.push(...readMessages(voucher));
    }
  }
  const normalized = status?.toUpperCase();
  if (normalized !== 'RECIBIDA' && normalized !== 'DEVUELTA') throw invalidResponse();
  return {
    outcome: normalized === 'RECIBIDA' ? 'RECEIVED' : 'RETURNED',
    sriStatus: normalized,
    messages: messages.slice(0, MAX_MESSAGES),
  };
}

function parseAuthorization(body: string): AuthorizationResult {
  const response = responseElement(body, 'RespuestaAutorizacionComprobante');
  const [list] = elementChildren(response, 'autorizaciones');
  const entries = list ? elementChildren(list, 'autorizacion') : [];
  const pending: AuthorizationResult = {
    outcome: 'PENDING',
    sriStatus: null,
    authorizationNumber: null,
    authorizedAt: null,
    environmentLabel: null,
    messages: [],
  };
  if (entries.length === 0) return pending;

  // Several answers may be listed (e.g. rejected ones and a single authorized one): that one wins.
  const authorizedEntry = entries.find(
    (e) => childText(e, 'estado')?.toUpperCase() === 'AUTORIZADO',
  );
  if (authorizedEntry) {
    const number = childText(authorizedEntry, 'numeroAutorizacion');
    const authorizedAt = parseSriDate(childText(authorizedEntry, 'fechaAutorizacion'));
    if (!number || !AUTHORIZATION_NUMBER.test(number) || !authorizedAt) throw invalidResponse();
    return {
      outcome: 'AUTHORIZED',
      sriStatus: 'AUTORIZADO',
      authorizationNumber: number,
      authorizedAt,
      environmentLabel: bounded(childText(authorizedEntry, 'ambiente'), MAX_STATUS),
      messages: readMessages(authorizedEntry),
    };
  }

  // Otherwise the most recent entry decides.
  let latest = entries[0];
  let latestDate = parseSriDate(childText(latest, 'fechaAutorizacion'));
  for (const entry of entries) {
    const date = parseSriDate(childText(entry, 'fechaAutorizacion'));
    if (date && (!latestDate || date > latestDate)) {
      latest = entry;
      latestDate = date;
    }
  }
  const status = bounded(childText(latest, 'estado'), MAX_STATUS);
  const rejected = status !== null && ['NO AUTORIZADO', 'RECHAZADO'].includes(status.toUpperCase());
  return {
    outcome: rejected ? 'NOT_AUTHORIZED' : 'PENDING',
    sriStatus: status,
    authorizationNumber: null,
    authorizedAt: latestDate,
    environmentLabel: bounded(childText(latest, 'ambiente'), MAX_STATUS),
    messages: readMessages(latest),
  };
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export class SriClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly testBaseUrl?: string;

  constructor(options: { fetch?: typeof fetch; testBaseUrl?: string; timeoutMs?: number } = {}) {
    if (options.testBaseUrl !== undefined && process.env.NODE_ENV !== 'test') {
      throw new Error('testBaseUrl is only allowed when NODE_ENV is test');
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.testBaseUrl = options.testBaseUrl?.replace(/\/+$/, '');
  }

  async send(
    environment: SriEnvironment,
    signedXml: Buffer,
    options: SriCallOptions = {},
  ): Promise<ReceptionResult> {
    const soap = soapEnvelope(
      RECEPTION_NS,
      `<ec:validarComprobante><xml>${signedXml.toString('base64')}</xml></ec:validarComprobante>`,
    );
    return parseReception(await this.post(this.url(environment, 'reception'), soap, options));
  }

  async authorize(
    environment: SriEnvironment,
    accessKey: string,
    options: SriCallOptions = {},
  ): Promise<AuthorizationResult> {
    if (!ACCESS_KEY.test(accessKey)) throw new SriError('data', 'INVALID_ACCESS_KEY');
    const soap = soapEnvelope(
      AUTHORIZATION_NS,
      `<ec:autorizacionComprobante><claveAccesoComprobante>${accessKey}</claveAccesoComprobante></ec:autorizacionComprobante>`,
    );
    return parseAuthorization(
      await this.post(this.url(environment, 'authorization'), soap, options),
    );
  }

  /** True when the reception WSDL answers; never throws. */
  async ping(environment: SriEnvironment): Promise<boolean> {
    try {
      await this.exchange(`${this.url(environment, 'reception')}?wsdl`, { method: 'GET' });
      return true;
    } catch {
      return false;
    }
  }

  private url(environment: SriEnvironment, service: 'reception' | 'authorization'): string {
    if (this.testBaseUrl) {
      return this.testBaseUrl + (service === 'reception' ? RECEPTION_PATH : AUTHORIZATION_PATH);
    }
    return SRI_ENDPOINTS[environment][service];
  }

  private post(url: string, soap: string, options: SriCallOptions): Promise<string> {
    return this.exchange(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
        body: soap,
      },
      options.timeoutMs,
    );
  }

  /** One HTTP exchange bounded in time and size; anything but a complete 2xx is a transient SriError. */
  private async exchange(
    url: string,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status === 429) {
        throw new SriError('transient', 'SRI_UNAVAILABLE', {
          status: 429,
          retryAfterMs: retryAfterMs(response.headers.get('Retry-After')),
        });
      }
      if (!response.ok) {
        throw new SriError('transient', 'SRI_UNAVAILABLE', { status: response.status });
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_RESPONSE_BYTES) throw invalidResponse();
      return bytes.toString('utf8');
    } catch (error) {
      if (error instanceof SriError) throw error;
      if (controller.signal.aborted) throw new SriError('transient', 'SRI_TIMEOUT');
      throw new SriError('transient', 'SRI_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }
}
