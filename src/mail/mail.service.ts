import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { MailContent, invitationMail, passwordResetMail } from './mail.templates';

const SEND_TIMEOUT_MS = 10_000;
const SMTP_SUBMISSION_PORT = 587;
const SMTP_IMPLICIT_TLS_PORT = 465;

/**
 * Transactional e-mail, sent from EMAIL_FROM, e.g. "HCX Care <no-reply@example.com>", through
 * one of two transports. SMTP wins when both are configured:
 *
 *   SMTP_HOST       server of the mail provider (the same values given to Supabase Auth)
 *   SMTP_PORT       587 by default (STARTTLS is required); 465 uses implicit TLS
 *   SMTP_USER
 *   SMTP_PASS
 *
 * or an HTTP mail API. The request body is `{ from, to, subject, html, text }` with a Bearer
 * key, the shape that Resend and most providers accept:
 *
 *   EMAIL_API_URL   endpoint that sends one message
 *   EMAIL_API_KEY   Bearer token
 *
 * Sending never throws: callers must not fail, or reveal that an address exists, because a
 * message could not be delivered. The result says whether the provider accepted it.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {
    if (this.isProduction && !this.isConfigured) {
      this.logger.error(
        'SMTP_HOST (or EMAIL_API_URL) and EMAIL_FROM are not set: password reset and invitation e-mails will not be delivered',
      );
    }
  }

  get isConfigured(): boolean {
    return (
      (!!this.config.get<string>('SMTP_HOST') || !!this.config.get<string>('EMAIL_API_URL')) &&
      !!this.config.get<string>('EMAIL_FROM')
    );
  }

  /** Base URL of the web app, used to build the links placed in messages. */
  get webUrl(): string {
    return (this.config.get<string>('FRONTEND_URL') || 'http://localhost:4200').replace(/\/+$/, '');
  }

  sendPasswordReset(to: string, input: { firstName: string; token: string; expiresIn: string }) {
    const resetUrl = `${this.webUrl}/reset-password?token=${encodeURIComponent(input.token)}`;
    return this.send(to, passwordResetMail({ ...input, resetUrl }));
  }

  sendInvitation(to: string, input: { firstName: string; clinicName: string }) {
    return this.send(to, invitationMail({ ...input, loginUrl: `${this.webUrl}/login` }));
  }

  async send(to: string, content: MailContent): Promise<boolean> {
    if (!this.isConfigured) {
      if (this.isProduction || content.sensitive) {
        // Never log the body here: it carries links that grant access to the account. A message
        // flagged sensitive (invoices) is never printed, in any environment, and not addressed either.
        this.logger.error(`E-mail "${content.subject}" not sent: mail provider is not configured`);
      } else {
        // Outside production the message is printed so the flow can be followed locally.
        this.logger.warn(`Mail provider not configured. Message for ${to}:\n${content.text}`);
      }
      return false;
    }

    const message = {
      from: this.config.get<string>('EMAIL_FROM'),
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
    };
    try {
      if (this.config.get<string>('SMTP_HOST')) {
        await this.smtpTransport().sendMail({
          ...message,
          ...(content.attachments?.length ? { attachments: content.attachments } : {}),
        });
        return true;
      }

      const apiKey = this.config.get<string>('EMAIL_API_KEY');
      const response = await fetch(this.config.get<string>('EMAIL_API_URL')!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          ...message,
          ...(content.attachments?.length
            ? {
                attachments: content.attachments.map((file) => ({
                  filename: file.filename,
                  content: file.content.toString('base64'),
                })),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.error(
          `E-mail "${content.subject}" rejected by the provider with status ${response.status}`,
        );
        return false;
      }
      return true;
    } catch (error) {
      // The provider text may quote the recipient, so sensitive messages do not repeat it.
      this.logger.error(
        content.sensitive
          ? `E-mail "${content.subject}" could not be sent`
          : `E-mail "${content.subject}" could not be sent: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private smtpTransport() {
    const port = Number(this.config.get<string>('SMTP_PORT')) || SMTP_SUBMISSION_PORT;
    const secure = port === SMTP_IMPLICIT_TLS_PORT;
    return createTransport({
      host: this.config.get<string>('SMTP_HOST'),
      port,
      secure,
      // The messages carry links that grant access: never fall back to an unencrypted session.
      requireTLS: !secure,
      auth: {
        user: this.config.get<string>('SMTP_USER'),
        pass: this.config.get<string>('SMTP_PASS'),
      },
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }

  private get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }
}
