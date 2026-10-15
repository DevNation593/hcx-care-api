import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import {
  evaluateExpression,
  ExpressionError,
  parseExpression,
  referencedFields,
} from './form-expression';

export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'integer',
  'decimal',
  'date',
  'time',
  'checkbox',
  'radio',
  'select',
  'multiselect',
  'scale',
  'table',
  'calculated',
  // A handwritten signature drawn on screen, kept as a PNG image inside the record.
  'signature',
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const FORM_ALERT_LEVELS = ['info', 'warning', 'critical'] as const;
export type FormAlertLevel = (typeof FORM_ALERT_LEVELS)[number];

export interface FormFieldOption {
  value: string;
  label: string;
}

/** Catalogs a text field can offer suggestions from. The value stays free text. */
export const FORM_FIELD_LOOKUPS = ['diagnosis', 'medication'] as const;
export type FormFieldLookup = (typeof FORM_FIELD_LOOKUPS)[number];

export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  help?: string;
  unit?: string;
  /** Numeric bounds for integer, decimal and scale fields. */
  min?: number;
  max?: number;
  maxLength?: number;
  /** Choices of radio, select and multiselect; optional point labels of a scale. */
  options?: FormFieldOption[];
  /** Columns of a table field. Tables hold scalar columns only. */
  columns?: FormField[];
  minRows?: number;
  maxRows?: number;
  /** Expression of a calculated field. The server computes it; clients never send it. */
  formula?: string;
  /** Text fields only: the catalog the client suggests values from. */
  lookup?: FormFieldLookup;
}

export interface FormSection {
  key: string;
  title: string;
  description?: string;
  fields: FormField[];
}

export interface FormAlertRule {
  when: string;
  level: FormAlertLevel;
  message: string;
}

export interface FormSchema {
  sections: FormSection[];
  alerts?: FormAlertRule[];
}

export interface FormAlert {
  level: FormAlertLevel;
  message: string;
}

export interface FormIssue {
  field: string;
  message: string;
}

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const SIGNATURE_PREFIX = 'data:image/png;base64,';
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A signature pad produces a few kilobytes; this leaves room for a dense one and no more. */
export const MAX_SIGNATURE_CHARS = 200_000;
const NUMERIC_TYPES: readonly FormFieldType[] = ['integer', 'decimal', 'scale', 'calculated'];
const CHOICE_TYPES: readonly FormFieldType[] = ['radio', 'select', 'multiselect'];
const TABLE_COLUMN_TYPES: readonly FormFieldType[] = [
  'text',
  'textarea',
  'integer',
  'decimal',
  'date',
  'time',
  'checkbox',
  'select',
];

const DEFAULT_MAX_LENGTH: Partial<Record<FormFieldType, number>> = { text: 500, textarea: 10000 };
const DEFAULT_MAX_ROWS = 100;
const LIMITS = { sections: 30, fields: 200, options: 100, columns: 12, alerts: 30, rows: 500 };

export function listFormFields(schema: FormSchema): FormField[] {
  return schema.sections.flatMap((section) => section.fields);
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// ============================================
// DATA VALIDATION
// ============================================

type ScalarResult = { value: unknown } | { error: string };

function normalizeNumber(field: FormField, raw: unknown): ScalarResult {
  const number =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw.trim().replace(',', '.'))
        : NaN;
  if (!Number.isFinite(number)) return { error: 'Debe ser un número' };
  if (field.type !== 'decimal' && !Number.isInteger(number)) {
    return { error: 'Debe ser un número entero' };
  }
  if (field.min !== undefined && number < field.min) {
    return { error: `Debe ser mayor o igual a ${field.min}` };
  }
  if (field.max !== undefined && number > field.max) {
    return { error: `Debe ser menor o igual a ${field.max}` };
  }
  return { value: number };
}

function normalizeScalar(field: FormField, raw: unknown): ScalarResult {
  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'Debe ser texto' };
      const text = String(raw).trim();
      const maxLength = field.maxLength ?? DEFAULT_MAX_LENGTH[field.type]!;
      if (text.length > maxLength) return { error: `Máximo ${maxLength} caracteres` };
      return { value: text };
    }
    case 'integer':
    case 'decimal':
    case 'scale':
      return normalizeNumber(field, raw);
    case 'date':
      return typeof raw === 'string' && isRealDate(raw)
        ? { value: raw }
        : { error: 'Debe ser una fecha con formato AAAA-MM-DD' };
    case 'time':
      return typeof raw === 'string' && TIME_PATTERN.test(raw)
        ? { value: raw }
        : { error: 'Debe ser una hora con formato HH:mm' };
    case 'checkbox':
      if (typeof raw === 'boolean') return { value: raw };
      if (raw === 'true' || raw === 'false') return { value: raw === 'true' };
      return { error: 'Debe ser verdadero o falso' };
    case 'radio':
    case 'select':
      return typeof raw === 'string' && field.options?.some((option) => option.value === raw)
        ? { value: raw }
        : { error: 'Selecciona una opción válida' };
    case 'multiselect': {
      if (!Array.isArray(raw)) return { error: 'Debe ser una lista de opciones' };
      const allowed = new Set(field.options?.map((option) => option.value));
      if (raw.some((item) => typeof item !== 'string' || !allowed.has(item))) {
        return { error: 'Contiene una opción no válida' };
      }
      return { value: [...new Set(raw as string[])] };
    }
    case 'signature':
      return normalizeSignature(raw);
    default:
      return { error: 'Tipo de campo no admitido' };
  }
}

/** A signature is a PNG data URL: checked by its bytes, not by what it says it is. */
function normalizeSignature(raw: unknown): ScalarResult {
  if (typeof raw !== 'string' || !raw.startsWith(SIGNATURE_PREFIX)) {
    return { error: 'La firma debe ser una imagen PNG' };
  }
  if (raw.length > MAX_SIGNATURE_CHARS) return { error: 'La firma es demasiado grande' };

  const encoded = raw.slice(SIGNATURE_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return { error: 'La firma debe ser una imagen PNG' };
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length <= PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { error: 'La firma debe ser una imagen PNG' };
  }
  return { value: raw };
}

function normalizeTable(field: FormField, raw: unknown, issues: FormIssue[]): unknown[] | null {
  if (!Array.isArray(raw)) {
    issues.push({ field: field.key, message: 'Debe ser una lista de filas' });
    return null;
  }
  const columns = field.columns ?? [];
  const maxRows = field.maxRows ?? DEFAULT_MAX_ROWS;
  if (raw.length > maxRows) {
    issues.push({ field: field.key, message: `Máximo ${maxRows} filas` });
    return null;
  }

  const rows: Record<string, unknown>[] = [];
  raw.forEach((rawRow, index) => {
    const path = `${field.key}[${index}]`;
    if (!isRecord(rawRow)) {
      issues.push({ field: path, message: 'Cada fila debe ser un objeto' });
      return;
    }
    const known = new Set(columns.map((column) => column.key));
    for (const key of Object.keys(rawRow)) {
      if (!known.has(key)) issues.push({ field: `${path}.${key}`, message: 'Columna desconocida' });
    }
    // A row left entirely blank is dropped rather than reported column by column.
    if (columns.every((column) => isEmpty(rawRow[column.key]))) return;

    const row: Record<string, unknown> = {};
    for (const column of columns) {
      const value = rawRow[column.key];
      if (isEmpty(value)) {
        if (column.required) {
          issues.push({ field: `${path}.${column.key}`, message: 'Este campo es obligatorio' });
        }
        continue;
      }
      const result = normalizeScalar(column, value);
      if ('error' in result) issues.push({ field: `${path}.${column.key}`, message: result.error });
      else row[column.key] = result.value;
    }
    rows.push(row);
  });
  return rows;
}

export function clinicalRecordInvalid(issues: FormIssue[]) {
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'CLINICAL_RECORD_INVALID',
    message: 'El registro no cumple la definición del formulario.',
    details: issues,
  });
}

/**
 * Checks `input` against the schema and returns the data to store: trimmed, coerced to the
 * declared types, without empty optional fields and with the calculated fields filled in.
 * Throws CLINICAL_RECORD_INVALID (422) listing every problem found.
 */
export function validateFormData(schema: FormSchema, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw clinicalRecordInvalid([{ field: 'data', message: 'Debe ser un objeto' }]);
  }

  const fields = listFormFields(schema);
  const issues: FormIssue[] = [];
  const data: Record<string, unknown> = {};

  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) issues.push({ field: key, message: 'Campo desconocido' });
  }

  for (const field of fields) {
    // Calculated values come from the server only, whatever the client sent.
    if (field.type === 'calculated') continue;
    const raw = input[field.key];

    if (field.type === 'table') {
      const rows = raw === undefined || raw === null ? [] : normalizeTable(field, raw, issues);
      if (rows === null) continue;
      const minRows = field.minRows ?? (field.required ? 1 : 0);
      if (rows.length < minRows) {
        issues.push({
          field: field.key,
          message: minRows === 1 ? 'Agrega al menos una fila' : `Agrega al menos ${minRows} filas`,
        });
      } else if (rows.length > 0) {
        data[field.key] = rows;
      }
      continue;
    }

    if (isEmpty(raw)) {
      if (field.required) issues.push({ field: field.key, message: 'Este campo es obligatorio' });
      continue;
    }
    const result = normalizeScalar(field, raw);
    if ('error' in result) issues.push({ field: field.key, message: result.error });
    else data[field.key] = result.value;
  }

  if (issues.length > 0) throw clinicalRecordInvalid(issues);

  // In declaration order, so a calculated field can build on an earlier one.
  for (const field of fields) {
    if (field.type !== 'calculated' || !field.formula) continue;
    const value = evaluateExpression(parseExpression(field.formula), data);
    if (typeof value === 'number' && Number.isFinite(value)) data[field.key] = value;
  }

  return data;
}

/** The alert rules of the schema that the stored data triggers. */
export function evaluateFormAlerts(schema: FormSchema, data: unknown): FormAlert[] {
  if (!schema.alerts?.length || !isRecord(data)) return [];
  return schema.alerts.flatMap((rule) => {
    try {
      return evaluateExpression(parseExpression(rule.when), data) === true
        ? [{ level: rule.level, message: rule.message }]
        : [];
    } catch {
      return [];
    }
  });
}

// ============================================
// SCHEMA VALIDATION (tenant-defined forms)
// ============================================

function formDefinitionInvalid(issues: FormIssue[]) {
  return new BadRequestException({
    statusCode: 400,
    code: 'FORM_DEFINITION_INVALID',
    message: 'La definición del formulario no es válida.',
    details: issues,
  });
}

const text = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function sanitizeOptions(raw: unknown, path: string, issues: FormIssue[]): FormFieldOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    issues.push({ field: path, message: 'Agrega al menos una opción' });
    return [];
  }
  if (raw.length > LIMITS.options) {
    issues.push({ field: path, message: `Máximo ${LIMITS.options} opciones` });
    return [];
  }
  const options: FormFieldOption[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const value = isRecord(item) ? text(item.value, 100) : null;
    const label = isRecord(item) ? text(item.label, 200) : null;
    if (!value || !label) {
      issues.push({ field: `${path}[${index}]`, message: 'Cada opción necesita valor y etiqueta' });
    } else if (seen.has(value)) {
      issues.push({ field: `${path}[${index}]`, message: `Opción repetida: ${value}` });
    } else {
      seen.add(value);
      options.push({ value, label });
    }
  });
  return options;
}

function sanitizeField(
  raw: unknown,
  path: string,
  keys: Set<string>,
  issues: FormIssue[],
  insideTable: boolean,
): FormField | null {
  if (!isRecord(raw)) {
    issues.push({ field: path, message: 'El campo debe ser un objeto' });
    return null;
  }
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  const label = text(raw.label, 200);
  const type = raw.type as FormFieldType;

  if (!KEY_PATTERN.test(key)) {
    issues.push({
      field: `${path}.key`,
      message: 'La clave debe empezar con una letra y usar solo letras, números y guion bajo',
    });
    return null;
  }
  if (keys.has(key)) {
    issues.push({ field: `${path}.key`, message: `Clave repetida: ${key}` });
    return null;
  }
  keys.add(key);

  if (!label) issues.push({ field: `${path}.label`, message: 'La etiqueta es obligatoria' });
  const allowedTypes = insideTable ? TABLE_COLUMN_TYPES : FORM_FIELD_TYPES;
  if (!(allowedTypes as readonly string[]).includes(type)) {
    issues.push({ field: `${path}.type`, message: 'Tipo de campo no admitido' });
    return null;
  }

  const field: FormField = { key, label: label ?? key, type };
  if (raw.required === true && type !== 'calculated') field.required = true;
  const help = text(raw.help, 500);
  if (help) field.help = help;
  const unit = text(raw.unit, 30);
  if (unit) field.unit = unit;

  if (NUMERIC_TYPES.includes(type) && type !== 'calculated') {
    const min = optionalNumber(raw.min);
    const max = optionalNumber(raw.max);
    if (type === 'scale' && (min === undefined || max === undefined)) {
      issues.push({ field: path, message: 'Una escala necesita mínimo y máximo' });
    }
    if (min !== undefined && max !== undefined && min > max) {
      issues.push({ field: path, message: 'El mínimo no puede superar al máximo' });
    }
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
    if (type === 'scale' && raw.options !== undefined) {
      field.options = sanitizeOptions(raw.options, `${path}.options`, issues);
    }
  }

  if (type === 'text' || type === 'textarea') {
    const maxLength = optionalNumber(raw.maxLength);
    if (maxLength !== undefined) {
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 10000) {
        issues.push({ field: `${path}.maxLength`, message: 'Longitud máxima no válida' });
      } else {
        field.maxLength = maxLength;
      }
    }
    if (raw.lookup !== undefined) {
      if (type === 'text' && (FORM_FIELD_LOOKUPS as readonly unknown[]).includes(raw.lookup)) {
        field.lookup = raw.lookup as FormFieldLookup;
      } else {
        issues.push({ field: `${path}.lookup`, message: 'Catálogo de sugerencias no válido' });
      }
    }
  }

  if (CHOICE_TYPES.includes(type)) {
    field.options = sanitizeOptions(raw.options, `${path}.options`, issues);
  }

  if (type === 'table') {
    if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
      issues.push({ field: `${path}.columns`, message: 'La tabla necesita al menos una columna' });
    } else if (raw.columns.length > LIMITS.columns) {
      issues.push({ field: `${path}.columns`, message: `Máximo ${LIMITS.columns} columnas` });
    } else {
      const columnKeys = new Set<string>();
      field.columns = raw.columns
        .map((column, index) =>
          sanitizeField(column, `${path}.columns[${index}]`, columnKeys, issues, true),
        )
        .filter((column): column is FormField => column !== null);
    }
    for (const bound of ['minRows', 'maxRows'] as const) {
      const value = optionalNumber(raw[bound]);
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0 || value > LIMITS.rows) {
        issues.push({ field: `${path}.${bound}`, message: 'Número de filas no válido' });
      } else {
        field[bound] = value;
      }
    }
  }

  if (type === 'calculated') {
    const formula = text(raw.formula, 500);
    if (!formula) issues.push({ field: `${path}.formula`, message: 'La fórmula es obligatoria' });
    else field.formula = formula;
  }

  return field;
}

function checkExpression(
  source: string,
  path: string,
  available: Map<string, FormField>,
  issues: FormIssue[],
  numericOnly: boolean,
) {
  try {
    for (const name of referencedFields(parseExpression(source))) {
      const target = available.get(name);
      if (!target) {
        issues.push({ field: path, message: `La expresión usa un campo inexistente: ${name}` });
      } else if (target.type === 'table' || target.type === 'multiselect') {
        issues.push({ field: path, message: `El campo ${name} no puede usarse en expresiones` });
      } else if (numericOnly && !NUMERIC_TYPES.includes(target.type)) {
        issues.push({ field: path, message: `El campo ${name} no es numérico` });
      }
    }
  } catch (error) {
    issues.push({
      field: path,
      message: error instanceof ExpressionError ? error.message : 'Expresión no válida',
    });
  }
}

/**
 * Validates a form schema written by a tenant and returns it without unknown properties.
 * Throws FORM_DEFINITION_INVALID (400) listing every problem found.
 */
export function validateFormSchema(raw: unknown): FormSchema {
  const issues: FormIssue[] = [];
  if (!isRecord(raw) || !Array.isArray(raw.sections) || raw.sections.length === 0) {
    throw formDefinitionInvalid([
      { field: 'sections', message: 'El formulario necesita al menos una sección' },
    ]);
  }
  if (raw.sections.length > LIMITS.sections) {
    throw formDefinitionInvalid([
      { field: 'sections', message: `Máximo ${LIMITS.sections} secciones` },
    ]);
  }

  const fieldKeys = new Set<string>();
  const sectionKeys = new Set<string>();
  const sections: FormSection[] = [];

  raw.sections.forEach((rawSection, sectionIndex) => {
    const path = `sections[${sectionIndex}]`;
    if (!isRecord(rawSection)) {
      issues.push({ field: path, message: 'La sección debe ser un objeto' });
      return;
    }
    const key = typeof rawSection.key === 'string' ? rawSection.key.trim() : '';
    const title = text(rawSection.title, 200);
    if (!KEY_PATTERN.test(key) || sectionKeys.has(key)) {
      issues.push({ field: `${path}.key`, message: 'Clave de sección no válida o repetida' });
    }
    sectionKeys.add(key);
    if (!title) issues.push({ field: `${path}.title`, message: 'El título es obligatorio' });
    if (!Array.isArray(rawSection.fields) || rawSection.fields.length === 0) {
      issues.push({ field: `${path}.fields`, message: 'La sección necesita al menos un campo' });
      return;
    }

    const section: FormSection = {
      key,
      title: title ?? key,
      fields: rawSection.fields
        .map((field, index) =>
          sanitizeField(field, `${path}.fields[${index}]`, fieldKeys, issues, false),
        )
        .filter((field): field is FormField => field !== null),
    };
    const description = text(rawSection.description, 500);
    if (description) section.description = description;
    sections.push(section);
  });

  const schema: FormSchema = { sections };
  const fields = listFormFields(schema);
  if (fields.length > LIMITS.fields) {
    issues.push({ field: 'sections', message: `Máximo ${LIMITS.fields} campos por formulario` });
  }

  // A formula reads only fields declared before it, which also rules out cycles.
  const declared = new Map<string, FormField>();
  for (const field of fields) {
    if (field.type === 'calculated' && field.formula) {
      checkExpression(field.formula, `${field.key}.formula`, declared, issues, true);
    }
    declared.set(field.key, field);
  }

  if (raw.alerts !== undefined) {
    if (!Array.isArray(raw.alerts) || raw.alerts.length > LIMITS.alerts) {
      issues.push({
        field: 'alerts',
        message: `Las alertas deben ser una lista de hasta ${LIMITS.alerts}`,
      });
    } else {
      schema.alerts = [];
      raw.alerts.forEach((rawRule, index) => {
        const path = `alerts[${index}]`;
        const when = isRecord(rawRule) ? text(rawRule.when, 500) : null;
        const message = isRecord(rawRule) ? text(rawRule.message, 300) : null;
        const level = isRecord(rawRule) ? (rawRule.level as FormAlertLevel) : undefined;
        if (!when || !message || !level || !FORM_ALERT_LEVELS.includes(level)) {
          issues.push({ field: path, message: 'La alerta necesita condición, nivel y mensaje' });
          return;
        }
        checkExpression(when, `${path}.when`, declared, issues, false);
        schema.alerts!.push({ when, level, message });
      });
    }
  }

  if (issues.length > 0) throw formDefinitionInvalid(issues);
  return schema;
}
