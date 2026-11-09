import { createHash } from 'crypto';

export const CONSENT_VARIABLES = [
  'paciente',
  'identificacion',
  'tratamiento',
  // What a procedure consent is for; in a treatment session it is the treatment.
  'procedimiento',
  'profesional',
  'fecha',
] as const;

export type ConsentValues = Record<
  Exclude<(typeof CONSENT_VARIABLES)[number], 'procedimiento'>,
  string
> & {
  procedimiento?: string;
};

const VARIABLE = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

/**
 * Fills the `{{ name }}` placeholders of a consent text. Names that are not one of
 * CONSENT_VARIABLES are left as written so a typo in a template stays visible.
 */
export function renderConsentText(text: string, values: ConsentValues): string {
  return text.replace(VARIABLE, (placeholder, name: string) =>
    (CONSENT_VARIABLES as readonly string[]).includes(name)
      ? (values[name as keyof ConsentValues] ?? values.tratamiento)
      : placeholder,
  );
}

/** Fingerprint of the exact title and body a patient signed. */
export function consentChecksum(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex');
}
