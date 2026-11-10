import { BadRequestException, ValidationError } from '@nestjs/common';
import { fieldLabel } from './field-labels';

export interface FieldIssue {
  field: string;
  message: string;
}

/** How many issues the summary message names before it only counts the rest. */
const SUMMARY_LIMIT = 3;

interface DefaultRule {
  /** class-validator's default text after "<property> ", with the limit it names captured. */
  template: RegExp;
  /** What the rule asks for, in Spanish, after "El campo «X»". */
  describe: (arg: string) => string;
}

const NUMBER = '(-?\\d+(?:\\.\\d+)?)';
const elements = (n: string) => `${n} elemento${n === '1' ? '' : 's'}`;
const rule = (template: string, describe: DefaultRule['describe']): DefaultRule => ({
  template: new RegExp(`^${template}$`),
  describe,
});

/**
 * The default messages of the class-validator decorators the DTOs use. Only a message that matches
 * its rule's template is translated: a DTO's custom message (even an English one with "must") is
 * kept as written, and a limit is read from the template, never from digits of the field name.
 */
const DEFAULT_RULES: Record<string, DefaultRule> = {
  isNotEmpty: rule('should not be empty', () => 'es obligatorio'),
  arrayNotEmpty: rule('should not be empty', () => 'no puede estar vacío'),
  isDefined: rule('should not be null or undefined', () => 'es obligatorio'),
  isString: rule('must be a string', () => 'debe ser texto'),
  maxLength: rule(
    'must be shorter than or equal to (\\d+) characters',
    (n) => `debe tener como máximo ${n} caracteres`,
  ),
  minLength: rule(
    'must be longer than or equal to (\\d+) characters',
    (n) => `debe tener al menos ${n} caracteres`,
  ),
  min: rule(`must not be less than ${NUMBER}`, (n) => `debe ser mayor o igual a ${n}`),
  max: rule(`must not be greater than ${NUMBER}`, (n) => `debe ser menor o igual a ${n}`),
  isInt: rule('must be an integer number', () => 'debe ser un número entero'),
  isNumber: rule(
    'must be a number conforming to the specified constraints',
    () => 'debe ser un número',
  ),
  isNumberString: rule('must be a number string', () => 'debe ser un número'),
  isDecimal: rule('is not a valid decimal number\\.', () => 'debe ser un número decimal'),
  isPositive: rule('must be a positive number', () => 'debe ser mayor que 0'),
  isBoolean: rule('must be a boolean value', () => 'debe ser verdadero o falso'),
  isEnum: rule(
    'must be one of the following values: (.*)',
    (v) => `debe ser uno de estos valores: ${v}`,
  ),
  isIn: rule(
    'must be one of the following values: (.*)',
    (v) => `debe ser uno de estos valores: ${v}`,
  ),
  isArray: rule('must be an array', () => 'debe ser una lista'),
  arrayMinSize: rule(
    'must contain at least (\\d+) elements',
    (n) => `debe tener al menos ${elements(n)}`,
  ),
  arrayMaxSize: rule(
    'must contain no more than (\\d+) elements',
    (n) => `debe tener como máximo ${elements(n)}`,
  ),
  isEmail: rule('must be an email', () => 'debe ser un correo electrónico válido'),
  isObject: rule('must be an object', () => 'debe ser un objeto'),
  isDateString: rule('must be a valid ISO 8601 date string', () => 'debe ser una fecha válida'),
  isIso8601: rule('must be a valid ISO 8601 date string', () => 'debe ser una fecha válida'),
  isUrl: rule('must be a URL address', () => 'debe ser una URL válida'),
  isUuid: rule('must be a UUID', () => 'debe ser un identificador válido'),
  matches: rule('must match .+ regular expression', () => 'no tiene el formato esperado'),
  equals: rule('must be equal to .+', () => 'no tiene el valor esperado'),
};

function joinPath(parent: string, property: string): string {
  if (!parent) return property;
  return /^\d+$/.test(property) ? `${parent}[${property}]` : `${parent}.${property}`;
}

/** "Cantidad" for `lines[2].quantity`, followed by the position of the item it belongs to. */
function labelOf(path: string): string {
  const leaf = /([A-Za-z_$][\w$]*)(?:\[\d+\])?$/.exec(path)?.[1] ?? path;
  const index = /\[(\d+)\](?:\.[^[\]]+)?$/.exec(path)?.[1];
  const label = `«${fieldLabel(leaf)}»`;
  return index === undefined ? label : `${label} (elemento ${Number(index) + 1})`;
}

function issueMessage(path: string, property: string, constraint: string, message: string): string {
  if (constraint === 'whitelistValidation') return `El campo ${labelOf(path)} no está permitido.`;
  const defaultRule = Object.hasOwn(DEFAULT_RULES, constraint)
    ? DEFAULT_RULES[constraint]
    : undefined;
  const each = message.startsWith(`each value in ${property} `);
  const subject = each ? `each value in ${property} ` : `${property} `;
  if (!defaultRule || !message.startsWith(subject)) return message;
  const match = defaultRule.template.exec(message.slice(subject.length));
  if (!match) return message;
  const what = defaultRule.describe(match[1] ?? '');
  return `${each ? 'Cada valor del campo' : 'El campo'} ${labelOf(path)} ${what}.`;
}

/** One issue per broken constraint, nested objects and lists included (`lines[0].quantity`). */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldIssue[] {
  return errors.flatMap((error) => {
    const field = joinPath(parent, error.property);
    const constraints = Object.entries(error.constraints ?? {});
    // A missing value breaks every rule of its field: saying it is required is enough.
    const required = constraints.filter(([name]) => name === 'isNotEmpty' || name === 'isDefined');
    const own = (required.length ? required.slice(0, 1) : constraints).map(
      ([constraint, message]) => ({
        field,
        message: issueMessage(field, error.property, constraint, message),
      }),
    );
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/** A single text that names the first problems, for the toast or alert of the client. */
export function summarizeIssues(issues: FieldIssue[]): string {
  if (issues.length === 0) return 'Los datos enviados no son válidos.';
  const shown = issues.slice(0, SUMMARY_LIMIT).map((issue) => issue.message);
  const rest = issues.length - shown.length;
  if (rest > 0) shown.push(`Y ${rest} problema${rest === 1 ? '' : 's'} más.`);
  return shown.join(' ');
}

/**
 * exceptionFactory of the global ValidationPipe: a 400 whose `message` names what is wrong in
 * Spanish and whose `details` lists one issue per field, the shape the web client already reads.
 */
export function validationExceptionFactory(errors: ValidationError[]): BadRequestException {
  const details = flattenValidationErrors(errors);
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code: 'VALIDATION_ERROR',
    message: summarizeIssues(details),
    details,
  });
}
