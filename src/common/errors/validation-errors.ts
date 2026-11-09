import { BadRequestException, ValidationError } from '@nestjs/common';
import { fieldLabel } from './field-labels';

export interface FieldIssue {
  field: string;
  message: string;
}

/** How many issues the summary message names before it only counts the rest. */
const SUMMARY_LIMIT = 3;

/** class-validator's own (English) messages; a DTO's custom message is kept as written. */
function isDefaultMessage(message: string): boolean {
  return /\b(must|should)\b/.test(message) || /^(property |an unknown value)/.test(message);
}

function firstNumber(message: string): string | undefined {
  return /-?\d+(?:\.\d+)?/.exec(message)?.[0];
}

function allowedValues(message: string): string | undefined {
  return /following values: (.+)$/.exec(message)?.[1];
}

/** What a broken constraint asks for, in Spanish, after "El campo «X»". */
function describeConstraint(constraint: string, message: string): string {
  const n = firstNumber(message);
  switch (constraint) {
    case 'isNotEmpty':
    case 'isDefined':
      return 'es obligatorio';
    case 'isString':
      return 'debe ser texto';
    case 'maxLength':
      return n ? `debe tener como máximo ${n} caracteres` : 'es demasiado largo';
    case 'minLength':
      return n ? `debe tener al menos ${n} caracteres` : 'es demasiado corto';
    case 'isLength':
      return 'no tiene una longitud válida';
    case 'min':
      return n ? `debe ser mayor o igual a ${n}` : 'es demasiado pequeño';
    case 'max':
      return n ? `debe ser menor o igual a ${n}` : 'es demasiado grande';
    case 'isInt':
      return 'debe ser un número entero';
    case 'isNumber':
    case 'isNumberString':
    case 'isDecimal':
      return 'debe ser un número';
    case 'isPositive':
      return 'debe ser mayor que 0';
    case 'isBoolean':
      return 'debe ser verdadero o falso';
    case 'isEnum':
    case 'isIn': {
      const values = allowedValues(message);
      return values ? `debe ser uno de estos valores: ${values}` : 'no es un valor permitido';
    }
    case 'isArray':
      return 'debe ser una lista';
    case 'arrayMinSize':
    case 'arrayNotEmpty':
      return n
        ? `debe tener al menos ${n} elemento${n === '1' ? '' : 's'}`
        : 'no puede estar vacío';
    case 'arrayMaxSize':
      return n
        ? `debe tener como máximo ${n} elemento${n === '1' ? '' : 's'}`
        : 'tiene demasiados elementos';
    case 'arrayUnique':
      return 'no puede tener valores repetidos';
    case 'isEmail':
      return 'debe ser un correo electrónico válido';
    case 'isObject':
      return 'debe ser un objeto';
    case 'isDateString':
    case 'isIso8601':
    case 'isDate':
      return 'debe ser una fecha válida';
    case 'isUrl':
      return 'debe ser una URL válida';
    case 'isUuid':
    case 'isUUID':
      return 'debe ser un identificador válido';
    case 'matches':
      return 'no tiene el formato esperado';
    case 'equals':
      return 'no tiene el valor esperado';
    default:
      return 'no es válido';
  }
}

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

function issueMessage(path: string, constraint: string, message: string): string {
  if (constraint === 'whitelistValidation') return `El campo ${labelOf(path)} no está permitido.`;
  if (!isDefaultMessage(message)) return message;
  const each = message.startsWith('each value in ');
  return `${each ? 'Cada valor del campo' : 'El campo'} ${labelOf(path)} ${describeConstraint(constraint, message)}.`;
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
        message: issueMessage(field, constraint, message),
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
