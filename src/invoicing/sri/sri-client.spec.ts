import { buildAuthorizedXml } from './authorized-xml';
import { SriClient, hasMessage } from './sri-client';
import {
  authorizations,
  authorized,
  autorizacion,
  fault,
  notAuthorized,
  processing,
  received,
  returned,
} from './testing/sri-soap-samples';

const KEY = '0503201201176001321000110010030009900641234567814';
const ERROR_46 = {
  identifier: '46',
  message: 'RUC no existe',
  additionalInfo: null,
  type: 'ERROR',
};

interface Call {
  url: string;
  method: string | undefined;
  body: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
}

type Fake =
  | string
  | { status?: number; body?: string; headers?: Record<string, string>; hang?: boolean };

function fake(response: Fake, timeoutMs?: number) {
  const calls: Call[] = [];
  const spec = typeof response === 'string' ? { body: response } : response;
  const fetchFake = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method,
      body: init.body as string,
      headers: init.headers as Record<string, string>,
      redirect: init.redirect,
    });
    if (spec.hang) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }
    return Promise.resolve(
      new Response(spec.body ?? '', { status: spec.status ?? 200, headers: spec.headers }),
    );
  }) as unknown as typeof fetch;
  return { client: new SriClient({ fetch: fetchFake, timeoutMs }), calls };
}

describe('SriClient', () => {
  it('posts validarComprobante with the signed XML in base64 to celcer', async () => {
    const { client, calls } = fake(received());
    await expect(client.send('1', Buffer.from('<x/>'))).resolves.toEqual({
      outcome: 'RECEIVED',
      sriStatus: 'RECIBIDA',
      messages: [],
    });
    expect(calls[0].url).toBe(
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toContain(
      '<ec:validarComprobante><xml>PHgvPg==</xml></ec:validarComprobante>',
    );
    expect(calls[0].headers['Content-Type']).toBe('text/xml; charset=utf-8');
    expect(calls[0].headers['SOAPAction']).toBe('""');
    expect(calls[0].redirect).toBe('error');
  });

  it('posts autorizacionComprobante to the production host', async () => {
    const { client, calls } = fake(authorized(KEY));
    await client.authorize('2', KEY);
    expect(calls[0].url).toBe(
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    );
    expect(calls[0].body).toContain(
      `<ec:autorizacionComprobante><claveAccesoComprobante>${KEY}</claveAccesoComprobante></ec:autorizacionComprobante>`,
    );
  });

  it('rejects a malformed access key before calling the SRI', async () => {
    const { client, calls } = fake(authorized(KEY));
    await expect(client.authorize('1', '123')).rejects.toMatchObject({ kind: 'data' });
    expect(calls).toHaveLength(0);
  });

  it('reads every message of a DEVUELTA', async () => {
    const r = await fake(
      returned(KEY, {
        identifier: '43',
        message: 'CLAVE ACCESO REGISTRADA',
        additionalInfo: null,
        type: 'ERROR',
      }),
    ).client.send('2', Buffer.from('x'));
    expect(r.outcome).toBe('RETURNED');
    expect(r.messages).toHaveLength(1);
    expect(hasMessage(r, '43')).toBe(true);
    expect(hasMessage(r, '44')).toBe(false);
  });

  it('reads an authorization with a trimmed number, date and environment', async () => {
    expect(await fake(authorized(KEY)).client.authorize('1', KEY)).toEqual({
      outcome: 'AUTHORIZED',
      sriStatus: 'AUTORIZADO',
      authorizationNumber: KEY,
      authorizedAt: new Date('2012-03-05T16:57:34.997-05:00'),
      environmentLabel: 'PRUEBAS',
      messages: [
        {
          identifier: '60',
          message: 'ESTE PROCESO FUE REALIZADO EN EL AMBIENTE DE PRUEBAS',
          additionalInfo: null,
          type: 'ADVERTENCIA',
        },
      ],
    });
  });

  it.each(['NO AUTORIZADO', 'RECHAZADO'])('maps %s to NOT_AUTHORIZED', async (state) => {
    const r = await fake(notAuthorized(KEY, state, ERROR_46)).client.authorize('1', KEY);
    expect(r.outcome).toBe('NOT_AUTHORIZED');
    expect(r.sriStatus).toBe(state);
    expect(r.authorizationNumber).toBeNull();
    expect(hasMessage(r, '46')).toBe(true);
  });

  it('treats zero authorizations and EN PROCESO as PENDING', async () => {
    const none = await fake(authorizations(KEY)).client.authorize('1', KEY);
    expect(none).toMatchObject({ outcome: 'PENDING', sriStatus: null, authorizationNumber: null });
    const inProcess = await fake(processing(KEY)).client.authorize('1', KEY);
    expect(inProcess).toMatchObject({ outcome: 'PENDING', sriStatus: 'EN PROCESO' });
  });

  it('prefers an AUTORIZADO entry when the SRI lists several', async () => {
    const body = authorizations(
      KEY,
      autorizacion('NO AUTORIZADO', null, '2012-02-13T16:34:48.997-05:00', 'PRUEBAS', ERROR_46),
      autorizacion('AUTORIZADO', KEY, '2012-03-05T16:57:34.997-05:00', 'PRUEBAS'),
    );
    expect(await fake(body).client.authorize('1', KEY)).toMatchObject({
      outcome: 'AUTHORIZED',
      authorizationNumber: KEY,
    });
  });

  it('reads a date without offset as Ecuador time', async () => {
    const body = authorizations(
      KEY,
      autorizacion('AUTORIZADO', KEY, '2012-03-05T16:57:34', 'PRODUCCIÓN'),
    );
    expect(await fake(body).client.authorize('2', KEY)).toMatchObject({
      authorizedAt: new Date('2012-03-05T16:57:34-05:00'),
      environmentLabel: 'PRODUCCIÓN',
    });
  });

  it.each([
    ['no number', autorizacion('AUTORIZADO', null, '2012-03-05T16:57:34.997-05:00', 'PRUEBAS')],
    ['a bad number', autorizacion('AUTORIZADO', 'abc', '2012-03-05T16:57:34.997-05:00', 'PRUEBAS')],
    ['no date', autorizacion('AUTORIZADO', KEY, null, 'PRUEBAS')],
  ])('rejects an AUTORIZADO with %s as an invalid response', async (_, item) =>
    fake(authorizations(KEY, item))
      .client.authorize('1', KEY)
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (error) => expect(error).toMatchObject({ kind: 'transient', code: 'SRI_INVALID_RESPONSE' }),
      ),
  );

  it.each([
    ['HTTP 503', { status: 503 }, 'SRI_UNAVAILABLE'],
    ['SOAP fault', { body: fault() }, 'SRI_INVALID_RESPONSE'],
    ['SOAP fault with HTTP 500', { status: 500, body: fault() }, 'SRI_UNAVAILABLE'],
    ['timeout', { hang: true }, 'SRI_TIMEOUT'],
    ['an empty body', { body: '' }, 'SRI_INVALID_RESPONSE'],
    [
      'an unknown reception state',
      { body: received().replace('RECIBIDA', 'OTRA') },
      'SRI_INVALID_RESPONSE',
    ],
    [
      'DOCTYPE',
      { body: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>' },
      'SRI_INVALID_RESPONSE',
    ],
  ] as [string, Fake, string][])('classifies %s as transient', async (_, response, code) => {
    await expect(fake(response, 50).client.send('1', Buffer.from('x'))).rejects.toMatchObject({
      kind: 'transient',
      code,
    });
  });

  it('classifies a network failure as unavailable', async () => {
    const client = new SriClient({
      fetch: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
    });
    await expect(client.send('1', Buffer.from('x'))).rejects.toMatchObject({
      kind: 'transient',
      code: 'SRI_UNAVAILABLE',
    });
  });

  it('classifies a redirect (refused by fetch) as unavailable', async () => {
    const client = new SriClient({
      fetch: (() =>
        Promise.reject(new TypeError('unexpected redirect'))) as unknown as typeof fetch,
    });
    await expect(client.authorize('1', KEY)).rejects.toMatchObject({ code: 'SRI_UNAVAILABLE' });
  });

  it('honours Retry-After on 429', async () => {
    await expect(
      fake({ status: 429, headers: { 'Retry-After': '120' } }).client.send('1', Buffer.from('x')),
    ).rejects.toMatchObject({
      kind: 'transient',
      code: 'SRI_UNAVAILABLE',
      status: 429,
      retryAfterMs: 120000,
    });
  });

  it('does not put SRI texts in the error', async () => {
    const error = await fake({ status: 503, body: 'secret SRI text' })
      .client.send('1', Buffer.from('x'))
      .catch((e) => e);
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error.message).toBe('SRI_UNAVAILABLE');
  });

  describe('ping', () => {
    it('GETs the reception WSDL and is true on 200', async () => {
      const { client, calls } = fake('<wsdl/>');
      await expect(client.ping('1')).resolves.toBe(true);
      expect(calls[0].url).toBe(
        'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
      );
      expect(calls[0].method).toBe('GET');
    });

    it.each([{ status: 503 }, { hang: true }])(
      'is false for %j without throwing',
      async (response) => {
        await expect(fake(response, 50).client.ping('2')).resolves.toBe(false);
      },
    );

    it('is false on a network failure', async () => {
      const client = new SriClient({
        fetch: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
      });
      await expect(client.ping('1')).resolves.toBe(false);
    });
  });

  describe('testBaseUrl', () => {
    const original = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = original;
    });

    it('replaces the host under NODE_ENV=test', async () => {
      const calls: string[] = [];
      const client = new SriClient({
        testBaseUrl: 'http://127.0.0.1:9999',
        fetch: ((url: string) => {
          calls.push(url);
          return Promise.resolve(new Response(received()));
        }) as unknown as typeof fetch,
      });
      await client.send('1', Buffer.from('x'));
      expect(calls[0]).toBe(
        'http://127.0.0.1:9999/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
      );
    });

    it('refuses a test base URL outside NODE_ENV=test', () => {
      process.env.NODE_ENV = 'production';
      expect(() => new SriClient({ testBaseUrl: 'http://127.0.0.1:9999' })).toThrow();
    });
  });
});

describe('buildAuthorizedXml', () => {
  const signedXml =
    '<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"></factura>';

  it('wraps the signed XML in an autorizacion document', () => {
    expect(
      buildAuthorizedXml({
        signedXml,
        authorizationNumber: KEY,
        authorizedAt: new Date('2026-10-07T15:15:30Z'),
        environmentLabel: 'PRUEBAS',
      }),
    ).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><autorizacion><estado>AUTORIZADO</estado><numeroAutorizacion>${KEY}</numeroAutorizacion><fechaAutorizacion>2026-10-07T10:15:30-05:00</fechaAutorizacion><ambiente>PRUEBAS</ambiente><comprobante><![CDATA[<?xml version="1.0" encoding="UTF-8"?><factura id="comprobante" version="1.1.0"></factura>]]></comprobante></autorizacion>`,
    );
  });

  it('truncates milliseconds and writes production', () => {
    const xml = buildAuthorizedXml({
      signedXml,
      authorizationNumber: KEY,
      authorizedAt: new Date('2026-10-07T03:00:00.999Z'),
      environmentLabel: 'PRODUCCIÓN',
    });
    expect(xml).toContain('<fechaAutorizacion>2026-10-06T22:00:00-05:00</fechaAutorizacion>');
    expect(xml).toContain('<ambiente>PRODUCCIÓN</ambiente>');
  });

  it('splits a CDATA terminator inside the signed XML', () => {
    const xml = buildAuthorizedXml({
      signedXml: '<a>]]></a>',
      authorizationNumber: KEY,
      authorizedAt: new Date('2026-10-07T15:15:30Z'),
      environmentLabel: 'PRUEBAS',
    });
    expect(xml).toContain('<comprobante><![CDATA[<a>]]]]><![CDATA[></a>]]></comprobante>');
  });
});
