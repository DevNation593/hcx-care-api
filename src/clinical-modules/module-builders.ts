import { FormField, FormFieldOption, FormSchema, FormSection } from '../clinical-forms/form-schema';

export type ClinicalModuleRenderer = 'FORM' | 'ODONTOGRAM';

export interface ClinicalModuleDefinition {
  moduleKey: string;
  /** SPECIALTY modules belong to one specialty; GENERAL ones are shared by every professional. */
  scope: 'SPECIALTY' | 'GENERAL';
  specialtyCode: string | null;
  /** GENERAL modules only: the specialties allowed to write them. Absent means all. */
  allowedSpecialtyCodes?: readonly string[];
  /** GENERAL modules only: health care content that non-health specialties never write. */
  healthOnly?: boolean;
  name: string;
  description: string;
  schemaVersion: number;
  renderer: ClinicalModuleRenderer;
  /**
   * Versions written before definitions existed: free values under known keys. They are
   * checked only for presence, exactly as they were when stored.
   */
  legacy?: boolean;
  schema: FormSchema;
}

type FieldExtras = Partial<Omit<FormField, 'key' | 'label' | 'type'>>;

export const choices = (labels: Record<string, string>): FormFieldOption[] =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

export const text = (key: string, label: string, extras: FieldExtras = {}): FormField => ({
  key,
  label,
  type: 'text',
  ...extras,
});

export const longText = (key: string, label: string, extras: FieldExtras = {}): FormField => ({
  key,
  label,
  type: 'textarea',
  ...extras,
});

export const integer = (key: string, label: string, extras: FieldExtras = {}): FormField => ({
  key,
  label,
  type: 'integer',
  ...extras,
});

export const decimal = (key: string, label: string, extras: FieldExtras = {}): FormField => ({
  key,
  label,
  type: 'decimal',
  ...extras,
});

export const date = (key: string, label: string, extras: FieldExtras = {}): FormField => ({
  key,
  label,
  type: 'date',
  ...extras,
});

export const checkbox = (key: string, label: string, extras: FieldExtras = {}): FormField => ({
  key,
  label,
  type: 'checkbox',
  ...extras,
});

export const select = (
  key: string,
  label: string,
  labels: Record<string, string>,
  extras: FieldExtras = {},
): FormField => ({ key, label, type: 'select', options: choices(labels), ...extras });

export const multiselect = (
  key: string,
  label: string,
  labels: Record<string, string>,
  extras: FieldExtras = {},
): FormField => ({ key, label, type: 'multiselect', options: choices(labels), ...extras });

export const scale = (
  key: string,
  label: string,
  min: number,
  max: number,
  extras: FieldExtras = {},
): FormField => ({ key, label, type: 'scale', min, max, ...extras });

export const table = (
  key: string,
  label: string,
  columns: FormField[],
  extras: FieldExtras = {},
): FormField => ({ key, label, type: 'table', columns, ...extras });

export const calculated = (
  key: string,
  label: string,
  formula: string,
  extras: FieldExtras = {},
): FormField => ({ key, label, type: 'calculated', formula, ...extras });

export const signature = (key: string, label: string, extras: FieldExtras = {}): FormField => ({
  key,
  label,
  type: 'signature',
  ...extras,
});

export const section = (key: string, title: string, fields: FormField[]): FormSection => ({
  key,
  title,
  fields,
});

/** A pre-definition version: every listed key was required, any value was accepted. */
export const legacySchema = (labels: Record<string, string>): FormSchema => ({
  sections: [
    section(
      'main',
      'Datos',
      Object.entries(labels).map(([key, label]) => text(key, label, { required: true })),
    ),
  ],
});
