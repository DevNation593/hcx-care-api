import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { MailService } from './mail.service';
import { describeDuration, invitationMail, invoiceMail, passwordResetMail } from './mail.templates';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('mail templates', () => {
  it('puts the reset link, its validity and the single-use notice in both bodies', () => {
    const mail = passwordResetMail({
      firstName: 'Ana',
      resetUrl: 'https://app.example.com/reset-password?token=abc.def',
      expiresIn: '1h',
    });

    expect(mail.subject).toBe('Restablece tu contraseña de HCX Care');
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain('https://app.example.com/reset-password?token=abc.def');
      expect(body).toContain('vence en 1 hora');
      expect(body).toContain('solo se puede usar una vez');
      expect(body).toContain('Hola Ana,');
    }
  });

  it('escapes names so they cannot inject markup', () => {
    const mail = invitationMail({
      firstName: '<script>alert(1)</script>',
      clinicName: 'Centro "A&B"',
      loginUrl: 'https://app.example.com/login',
    });

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('Centro &quot;A&amp;B&quot;');
    expect(mail.text).toContain('Centro "A&B"');
  });

  describe('invoice mail', () => {
    const input = {
      number: '001-002-000000123',
      issuerName: 'Clínica <Ejemplo>',
      customerName: 'María Pérez',
      authorizedAt: new Date('2026-10-08T03:30:00Z'),
    };

    it('names the invoice, the issuer and the customer, with the Ecuador date', () => {
      const mail = invoiceMail(input);
      expect(mail.subject).toBe('Factura 001-002-000000123 de Clínica <Ejemplo>');
      expect(mail.text).toContain('Hola María Pérez,');
      expect(mail.text).toContain('07/10/2026');
      expect(mail.html).toContain('Clínica &lt;Ejemplo&gt;');
      expect(mail.html).not.toContain('<Ejemplo>');
    });

    it('never puts clinical data in the invoice mail', () => {
      const mail = invoiceMail(input);
      expect(mail.text).not.toMatch(/diagn|sesión|paciente/i);
      expect(mail.html).not.toMatch(/diagn|sesión|paciente/i);
    });
  });

  it.each([
    ['1h', '1 hora'],
    ['2h', '2 horas'],
    ['30m', '30 minutos'],
    ['1d', '1 día'],
    ['soon', 'un tiempo limitado'],
  ])('describes %s as "%s"', (input, expected) => {
    expect(describeDuration(input)).toBe(expected);
  });
});

describe('MailService', () => {
  const configured = {
    EMAIL_API_URL: 'https://mail.example.test/send',
    EMAIL_API_KEY: 'key-123',
    EMAIL_FROM: 'HCX Care <no-reply@example.test>',
    FRONTEND_URL: 'https://app.example.test/',
  };
  const serviceWith = (values: Record<string, string>) =>
    new MailService({ get: (name: string) => values[name] } as unknown as ConfigService);
  let fetchSpy: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('delivers a password reset with a link to the web app', async () => {
    const sent = await serviceWith(configured).sendPasswordReset('ana@example.com', {
      firstName: 'Ana',
      token: 'abc.def+ghi',
      expiresIn: '1h',
    });

    expect(sent).toBe(true);
    const [url, request] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://mail.example.test/send');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer key-123' });
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      from: 'HCX Care <no-reply@example.test>',
      to: 'ana@example.com',
      subject: 'Restablece tu contraseña de HCX Care',
    });
    expect(body.text).toContain('https://app.example.test/reset-password?token=abc.def%2Bghi');
    expect(body.html).toContain('https://app.example.test/reset-password?token=abc.def%2Bghi');
  });

  it('delivers an invitation that points to the login page', async () => {
    await serviceWith(configured).sendInvitation('luis@example.com', {
      firstName: 'Luis',
      clinicName: 'Centro Integral',
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.subject).toBe('Te invitaron a Centro Integral en HCX Care');
    expect(body.text).toContain('https://app.example.test/login');
  });

  it.each([
    [
      'a rejected request',
      () => fetchSpy.mockResolvedValue({ ok: false, status: 422 } as Response),
    ],
    ['a network failure', () => fetchSpy.mockRejectedValue(new Error('timeout'))],
  ])('reports %s without throwing or logging the link', async (_label, arrange) => {
    arrange();

    await expect(
      serviceWith(configured).sendPasswordReset('ana@example.com', {
        firstName: 'Ana',
        token: 'secret-token',
        expiresIn: '1h',
      }),
    ).resolves.toBe(false);
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify([error.mock.calls, warn.mock.calls])).not.toContain('secret-token');
  });

  it('prints the message outside production when no provider is configured', async () => {
    const sent = await serviceWith({ NODE_ENV: 'development' }).sendPasswordReset('ana@x.com', {
      firstName: 'Ana',
      token: 'dev-token',
      expiresIn: '1h',
    });

    expect(sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('http://localhost:4200/reset-password?token=dev-token');
  });

  describe('invoice mail (SEC-API-12)', () => {
    const invoice = () =>
      invoiceMail({
        number: '001-002-000000123',
        issuerName: 'Centro Ejemplo',
        customerName: 'María Pérez Secreta',
        authorizedAt: new Date('2026-10-08T03:30:00Z'),
      });
    const logged = () => JSON.stringify([warn.mock.calls, error.mock.calls]);

    it.each(['development', 'test', undefined, 'production'])(
      'logs neither the recipient, the body nor the customer with no provider (NODE_ENV %s)',
      async (env) => {
        const content = invoice();
        content.attachments = [
          { filename: 'f-secreta.xml', content: Buffer.from('x'), contentType: 'application/xml' },
        ];
        const config = env ? { NODE_ENV: env } : {};

        await expect(
          serviceWith(config).send('cliente.secreto@example.com', content),
        ).resolves.toBe(false);

        const output = logged();
        expect(output).toContain('Factura 001-002-000000123 de Centro Ejemplo');
        for (const leaked of ['cliente.secreto', 'María', 'Pérez', 'Adjuntamos', 'f-secreta']) {
          expect(output).not.toContain(leaked);
        }
      },
    );

    it('does not echo the provider error, which may quote the address, when sending fails', async () => {
      const sendMail = jest.fn().mockRejectedValue(new Error('550 <cliente.secreto@example.com>'));
      (createTransport as jest.Mock).mockReturnValue({ sendMail });

      await expect(
        serviceWith({ SMTP_HOST: 'smtp.example.test', EMAIL_FROM: 'a@example.test' }).send(
          'cliente.secreto@example.com',
          invoice(),
        ),
      ).resolves.toBe(false);

      expect(logged()).not.toContain('cliente.secreto');
      expect(error).toHaveBeenCalledTimes(1);
    });

    it('still prints a password reset locally, as before', async () => {
      await serviceWith({ NODE_ENV: 'development' }).sendPasswordReset('ana@x.com', {
        firstName: 'Ana',
        token: 'dev-token',
        expiresIn: '1h',
      });

      expect(warn.mock.calls[0][0]).toContain('ana@x.com');
      expect(warn.mock.calls[0][0]).toContain('token=dev-token');
    });
  });

  describe('attachments', () => {
    const attachments = [
      { filename: 'factura-1.xml', content: Buffer.from('<a/>'), contentType: 'application/xml' },
      { filename: 'factura-1.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' },
    ];
    const content = { subject: 'Factura', html: '<p>x</p>', text: 'x', attachments };

    it('sends them to the HTTP API as base64 files', async () => {
      await expect(serviceWith(configured).send('ana@example.com', content)).resolves.toBe(true);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.attachments).toEqual([
        { filename: 'factura-1.xml', content: Buffer.from('<a/>').toString('base64') },
        { filename: 'factura-1.pdf', content: Buffer.from('%PDF').toString('base64') },
      ]);
    });

    it('omits the field when there are none', async () => {
      await serviceWith(configured).send('ana@example.com', { ...content, attachments: undefined });
      expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).not.toHaveProperty('attachments');
    });

    it('passes them through SMTP as they are', async () => {
      const sendMail = jest.fn().mockResolvedValue({});
      (createTransport as unknown as jest.Mock).mockReset().mockReturnValue({ sendMail });
      await serviceWith({ SMTP_HOST: 'smtp.example.test', EMAIL_FROM: 'a@b.test' }).send(
        'ana@example.com',
        content,
      );
      expect(sendMail.mock.calls[0][0].attachments).toEqual(attachments);
    });
  });

  describe('through SMTP', () => {
    const smtp = {
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'mailer',
      SMTP_PASS: 's3cret',
      EMAIL_FROM: 'HCX Care <no-reply@example.test>',
      FRONTEND_URL: 'https://app.example.test',
    };
    const createTransportMock = createTransport as unknown as jest.Mock;
    let sendMail: jest.Mock;

    beforeEach(() => {
      sendMail = jest.fn().mockResolvedValue({
        accepted: ['ana@example.com'],
        rejected: [],
        response: '250 2.0.0 OK',
        envelope: { from: 'no-reply@example.test', to: ['ana@example.com'] },
        messageId: '<1@example.test>',
      });
      createTransportMock.mockReset().mockReturnValue({ sendMail });
    });

    it('delivers with the SMTP credentials of the provider, ahead of the HTTP API', async () => {
      const sent = await serviceWith({
        ...smtp,
        SMTP_PORT: '465',
        EMAIL_API_URL: 'https://mail.example.test/send',
      }).sendPasswordReset('ana@example.com', {
        firstName: 'Ana',
        token: 'abc.def',
        expiresIn: '1h',
      });

      expect(sent).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(createTransportMock.mock.calls[0][0]).toMatchObject({
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        auth: { user: 'mailer', pass: 's3cret' },
      });
      const message = sendMail.mock.calls[0][0];
      expect(message).toMatchObject({
        from: 'HCX Care <no-reply@example.test>',
        to: 'ana@example.com',
        subject: 'Restablece tu contraseña de HCX Care',
      });
      expect(message.text).toContain('https://app.example.test/reset-password?token=abc.def');
      expect(message.html).toContain('https://app.example.test/reset-password?token=abc.def');
    });

    it('uses the submission port by default and refuses to send without STARTTLS', async () => {
      await serviceWith(smtp).sendInvitation('luis@example.com', {
        firstName: 'Luis',
        clinicName: 'Centro Integral',
      });

      expect(createTransportMock.mock.calls[0][0]).toMatchObject({
        port: 587,
        secure: false,
        requireTLS: true,
      });
    });

    it('reports an SMTP failure without throwing or logging the link', async () => {
      sendMail.mockRejectedValue(new Error('Invalid login: 535 Authentication failed'));

      await expect(
        serviceWith(smtp).sendPasswordReset('ana@example.com', {
          firstName: 'Ana',
          token: 'secret-token',
          expiresIn: '1h',
        }),
      ).resolves.toBe(false);
      expect(error.mock.calls[0][0]).toContain('535 Authentication failed');
      expect(JSON.stringify([error.mock.calls, warn.mock.calls])).not.toContain('secret-token');
    });

    it('does not report missing configuration at startup in production', () => {
      serviceWith({ ...smtp, NODE_ENV: 'production' });

      expect(error).not.toHaveBeenCalled();
    });
  });

  it('never logs the link in production, and warns at startup that mail is not configured', async () => {
    const service = serviceWith({ NODE_ENV: 'production' });
    expect(error.mock.calls[0][0]).toContain(
      'SMTP_HOST (or EMAIL_API_URL) and EMAIL_FROM are not set',
    );

    await service.sendPasswordReset('ana@x.com', {
      firstName: 'Ana',
      token: 'prod-token',
      expiresIn: '1h',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain('prod-token');
  });
});
