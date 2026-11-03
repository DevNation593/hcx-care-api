export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailContent {
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

const BRAND = 'HCX Care';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

function layout(title: string, paragraphs: string[], action?: { label: string; url: string }) {
  const body = paragraphs.map((text) => `<p style="margin:0 0 16px">${text}</p>`).join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#6b7280">Si el botón no funciona, copia este enlace en tu navegador:<br>${escapeHtml(action.url)}</p>`
    : '';

  return `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
      <h1 style="margin:0 0 20px;font-size:20px">${escapeHtml(title)}</h1>
      ${body}
      ${button}
      <p style="margin:24px 0 0;font-size:12px;color:#9ca3af">${BRAND}</p>
    </div>
  </body>
</html>`;
}

/** "1h" -> "1 hora"; anything unexpected falls back to a neutral wording. */
export function describeDuration(expiresIn: string): string {
  const match = /^(\d+)\s*([mhd])$/.exec(expiresIn.trim());
  if (!match) return 'un tiempo limitado';
  const amount = Number(match[1]);
  const unit = { m: ['minuto', 'minutos'], h: ['hora', 'horas'], d: ['día', 'días'] }[
    match[2] as 'm' | 'h' | 'd'
  ];
  return `${amount} ${amount === 1 ? unit[0] : unit[1]}`;
}

export function passwordResetMail(input: {
  firstName: string;
  resetUrl: string;
  expiresIn: string;
}): MailContent {
  const validity = describeDuration(input.expiresIn);
  const greeting = `Hola ${input.firstName},`;
  const intro = 'Recibimos una solicitud para restablecer la contraseña de tu cuenta.';
  const expiry = `El enlace vence en ${validity} y solo se puede usar una vez.`;
  const ignore =
    'Si no solicitaste este cambio, ignora este mensaje: tu contraseña actual sigue siendo válida.';

  return {
    subject: `Restablece tu contraseña de ${BRAND}`,
    html: layout('Restablece tu contraseña', [escapeHtml(greeting), intro, expiry, ignore], {
      label: 'Crear una contraseña nueva',
      url: input.resetUrl,
    }),
    text: [greeting, '', intro, '', input.resetUrl, '', expiry, ignore].join('\n'),
  };
}

export function invitationMail(input: {
  firstName: string;
  clinicName: string;
  loginUrl: string;
}): MailContent {
  const greeting = `Hola ${input.firstName},`;
  const intro = `Se creó una cuenta para ti en ${input.clinicName}.`;
  // Pending invitations are activated by the account holder, who sets the first password.
  const next =
    'El titular de la cuenta del consultorio activará tu acceso y te entregará tu contraseña inicial. Después podrás iniciar sesión y cambiarla.';

  return {
    subject: `Te invitaron a ${input.clinicName} en ${BRAND}`,
    html: layout('Tienes una invitación', [escapeHtml(greeting), escapeHtml(intro), next], {
      label: 'Ir a iniciar sesión',
      url: input.loginUrl,
    }),
    text: [greeting, '', intro, next, '', input.loginUrl].join('\n'),
  };
}

/** Ecuador has no daylight saving time, so its civil time is always UTC-5. */
function ecuadorDate(date: Date): string {
  const [year, month, day] = new Date(date.getTime() - 5 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Cover message of an authorized invoice. It only names the billing customer and the issuer: it
 * must never carry clinical data.
 */
export function invoiceMail(input: {
  number: string;
  issuerName: string;
  customerName: string;
  authorizedAt: Date;
}): MailContent {
  const greeting = `Hola ${input.customerName},`;
  const intro = `Adjuntamos tu factura electrónica ${input.number}, emitida por ${input.issuerName} el ${ecuadorDate(input.authorizedAt)}.`;
  const files = 'Incluye el comprobante autorizado en XML y su representación impresa en PDF.';

  return {
    subject: `Factura ${input.number} de ${input.issuerName}`,
    html: layout(`Factura ${input.number}`, [escapeHtml(greeting), escapeHtml(intro), files]),
    text: [greeting, '', intro, files].join('\n'),
  };
}
