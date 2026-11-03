import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import * as soap from '../../src/invoicing/sri/testing/sri-soap-samples';

export type SriSimulatorMode =
  | 'authorize'
  | 'pending'
  | 'return'
  | 'not-authorized'
  | 'reception-timeout'
  | 'down';

export interface SriSimulator {
  baseUrl: string;
  mode: (m: SriSimulatorMode) => void;
  /** Every voucher that reached the reception service, in arrival order. */
  received: { accessKey: string; xml: string }[];
  close(): Promise<void>;
}

const RECEPTION_PATH = '/comprobantes-electronicos-ws/RecepcionComprobantesOffline';
const AUTHORIZATION_PATH = '/comprobantes-electronicos-ws/AutorizacionComprobantesOffline';

/** The message an SRI rejection carries; only users with billing.view may read it. */
export const SIMULATED_SRI_MESSAGE = 'EXPLICACION_FISCAL_SIMULADA';

const rejection = {
  identifier: '35',
  message: SIMULATED_SRI_MESSAGE,
  additionalInfo: 'DETALLE_FISCAL_SIMULADO',
  type: 'ERROR',
};

/**
 * Local stand-in for the SRI offline web services, answering by access key. A voucher accepted by
 * reception (or registered while reception never answers) becomes known to authorization; an
 * unknown access key gets zero authorizations, as the real SRI does.
 */
export async function startSriSimulator(): Promise<SriSimulator> {
  let current: SriSimulatorMode = 'authorize';
  const received: { accessKey: string; xml: string }[] = [];
  const registered = new Set<string>();
  const hanging = new Set<ServerResponse>();

  const reply = (res: ServerResponse, body: string, status = 200) => {
    res.writeHead(status, { 'content-type': 'text/xml; charset=utf-8' });
    res.end(body);
  };

  const reception = (res: ServerResponse, body: string) => {
    const encoded = /<xml>([A-Za-z0-9+/=\s]+)<\/xml>/.exec(body)?.[1];
    const xml = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
    const accessKey = /<claveAcceso>(\d{49})<\/claveAcceso>/.exec(xml)?.[1];
    if (!accessKey) return reply(res, soap.fault(), 500);
    received.push({ accessKey, xml });
    if (current === 'return') return reply(res, soap.returned(accessKey, rejection));
    registered.add(accessKey);
    if (current === 'reception-timeout') {
      // Registered at the SRI, but the answer never arrives: the client times out.
      hanging.add(res);
      res.on('close', () => hanging.delete(res));
      return;
    }
    reply(res, soap.received());
  };

  const authorization = (res: ServerResponse, body: string) => {
    const accessKey = /<claveAccesoComprobante>(\d{49})<\/claveAccesoComprobante>/.exec(body)?.[1];
    if (!accessKey) return reply(res, soap.fault(), 500);
    if (!registered.has(accessKey)) return reply(res, soap.authorizations(accessKey));
    if (current === 'authorize') return reply(res, soap.authorized(accessKey));
    if (current === 'not-authorized')
      return reply(res, soap.notAuthorized(accessKey, 'NO AUTORIZADO', rejection));
    reply(res, soap.processing(accessKey));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (current === 'down') return reply(res, 'Service Unavailable', 503);
      if (req.method === 'GET' && (path === RECEPTION_PATH || path === AUTHORIZATION_PATH))
        return reply(res, '<definitions/>');
      if (req.method !== 'POST') return reply(res, '', 405);
      const body = Buffer.concat(chunks).toString('utf8');
      if (path === RECEPTION_PATH) return reception(res, body);
      if (path === AUTHORIZATION_PATH) return authorization(res, body);
      reply(res, '', 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    mode: (m) => {
      current = m;
    },
    received,
    close: async () => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
