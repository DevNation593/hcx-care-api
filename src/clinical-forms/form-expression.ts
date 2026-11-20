/**
 * The small expression language used by calculated fields and alert rules of clinical forms.
 * It is parsed here and never handed to `eval`: tenants write these expressions.
 *
 *   round(weightKg / ((heightCm / 100) ^ 2), 1)
 *   sum(q1, q2, q3) >= 20 or q9 >= 1
 *   severity == 'GRAVE'
 */

export type ExpressionValue = number | string | boolean | null;

export type ExpressionNode =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'field'; name: string }
  | { kind: 'unary'; operator: '-' | 'not'; operand: ExpressionNode }
  | { kind: 'binary'; operator: BinaryOperator; left: ExpressionNode; right: ExpressionNode }
  | { kind: 'call'; name: FunctionName; args: ExpressionNode[] };

type BinaryOperator =
  '+' | '-' | '*' | '/' | '^' | '>' | '>=' | '<' | '<=' | '==' | '!=' | 'and' | 'or';

const FUNCTIONS = ['sum', 'avg', 'min', 'max', 'round', 'abs'] as const;
type FunctionName = (typeof FUNCTIONS)[number];

const MAX_LENGTH = 500;
const MAX_DEPTH = 40;

export class ExpressionError extends Error {}

type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'name'; value: string }
  | { type: 'symbol'; value: string };

const SYMBOLS = ['>=', '<=', '==', '!=', '+', '-', '*', '/', '^', '>', '<', '(', ')', ','];

function tokenize(source: string): Token[] {
  if (source.length > MAX_LENGTH) {
    throw new ExpressionError(`La expresión supera los ${MAX_LENGTH} caracteres`);
  }

  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const rest = source.slice(position);

    const space = /^\s+/.exec(rest);
    if (space) {
      position += space[0].length;
      continue;
    }

    const number = /^\d+(\.\d+)?/.exec(rest);
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]) });
      position += number[0].length;
      continue;
    }

    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (name) {
      tokens.push({ type: 'name', value: name[0] });
      position += name[0].length;
      continue;
    }

    const text = /^'([^']*)'/.exec(rest);
    if (text) {
      tokens.push({ type: 'string', value: text[1] });
      position += text[0].length;
      continue;
    }

    const symbol = SYMBOLS.find((candidate) => rest.startsWith(candidate));
    if (symbol) {
      tokens.push({ type: 'symbol', value: symbol });
      position += symbol.length;
      continue;
    }

    throw new ExpressionError(`Carácter no válido en la expresión: "${rest[0]}"`);
  }
  return tokens;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ExpressionNode {
    if (this.tokens.length === 0) throw new ExpressionError('La expresión está vacía');
    const node = this.or();
    if (this.position < this.tokens.length) {
      throw new ExpressionError('La expresión tiene elementos sobrantes');
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private takeSymbol(...values: string[]): string | null {
    const token = this.peek();
    if (token?.type === 'symbol' && values.includes(token.value)) {
      this.position += 1;
      return token.value;
    }
    return null;
  }

  private takeKeyword(value: string): boolean {
    const token = this.peek();
    if (token?.type === 'name' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private or(): ExpressionNode {
    let node = this.and();
    while (this.takeKeyword('or')) {
      node = { kind: 'binary', operator: 'or', left: node, right: this.and() };
    }
    return node;
  }

  private and(): ExpressionNode {
    let node = this.not();
    while (this.takeKeyword('and')) {
      node = { kind: 'binary', operator: 'and', left: node, right: this.not() };
    }
    return node;
  }

  private not(): ExpressionNode {
    if (this.takeKeyword('not')) {
      return { kind: 'unary', operator: 'not', operand: this.not() };
    }
    return this.comparison();
  }

  private comparison(): ExpressionNode {
    const left = this.additive();
    const operator = this.takeSymbol('>=', '<=', '==', '!=', '>', '<');
    if (!operator) return left;
    return { kind: 'binary', operator: operator as BinaryOperator, left, right: this.additive() };
  }

  private additive(): ExpressionNode {
    let node = this.multiplicative();
    for (let op = this.takeSymbol('+', '-'); op; op = this.takeSymbol('+', '-')) {
      node = {
        kind: 'binary',
        operator: op as BinaryOperator,
        left: node,
        right: this.multiplicative(),
      };
    }
    return node;
  }

  private multiplicative(): ExpressionNode {
    let node = this.unary();
    for (let op = this.takeSymbol('*', '/'); op; op = this.takeSymbol('*', '/')) {
      node = { kind: 'binary', operator: op as BinaryOperator, left: node, right: this.unary() };
    }
    return node;
  }

  private unary(): ExpressionNode {
    if (this.takeSymbol('-')) {
      return { kind: 'unary', operator: '-', operand: this.unary() };
    }
    return this.power();
  }

  private power(): ExpressionNode {
    const base = this.primary();
    if (this.takeSymbol('^')) {
      return { kind: 'binary', operator: '^', left: base, right: this.unary() };
    }
    return base;
  }

  private primary(): ExpressionNode {
    const token = this.peek();
    if (!token) throw new ExpressionError('La expresión está incompleta');
    this.position += 1;

    if (token.type === 'number') return { kind: 'number', value: token.value };
    if (token.type === 'string') return { kind: 'string', value: token.value };

    if (token.type === 'symbol' && token.value === '(') {
      const node = this.nested(() => this.or());
      this.expect(')');
      return node;
    }

    if (token.type === 'name') {
      if (['and', 'or', 'not'].includes(token.value)) {
        throw new ExpressionError(`"${token.value}" no puede usarse como nombre de campo`);
      }
      if (!this.takeSymbol('(')) return { kind: 'field', name: token.value };

      if (!(FUNCTIONS as readonly string[]).includes(token.value)) {
        throw new ExpressionError(`Función desconocida: ${token.value}`);
      }
      const args: ExpressionNode[] = [];
      if (!this.takeSymbol(')')) {
        do {
          args.push(this.nested(() => this.or()));
        } while (this.takeSymbol(','));
        this.expect(')');
      }
      const name = token.value as FunctionName;
      const arity = name === 'abs' ? [1, 1] : name === 'round' ? [1, 2] : [1, 50];
      if (args.length < arity[0] || args.length > arity[1]) {
        throw new ExpressionError(`Número de argumentos no válido para ${name}()`);
      }
      return { kind: 'call', name, args };
    }

    throw new ExpressionError(`Elemento inesperado en la expresión: "${token.value}"`);
  }

  private nested(parse: () => ExpressionNode): ExpressionNode {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new ExpressionError('La expresión es demasiado profunda');
    const node = parse();
    this.depth -= 1;
    return node;
  }

  private expect(symbol: string) {
    if (!this.takeSymbol(symbol)) throw new ExpressionError(`Falta "${symbol}" en la expresión`);
  }
}

export function parseExpression(source: string): ExpressionNode {
  return new Parser(tokenize(source)).parse();
}

/** Every field name the expression reads. */
export function referencedFields(node: ExpressionNode): string[] {
  switch (node.kind) {
    case 'field':
      return [node.name];
    case 'unary':
      return referencedFields(node.operand);
    case 'binary':
      return [...referencedFields(node.left), ...referencedFields(node.right)];
    case 'call':
      return node.args.flatMap(referencedFields);
    default:
      return [];
  }
}

const asNumber = (value: ExpressionValue) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A missing operand makes arithmetic yield null and comparisons yield false, so an
 * incomplete form computes nothing and raises no alert instead of failing.
 */
export function evaluateExpression(
  node: ExpressionNode,
  scope: Record<string, unknown>,
): ExpressionValue {
  switch (node.kind) {
    case 'number':
    case 'string':
      return node.value;

    case 'field': {
      const value = scope[node.name];
      return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
        ? value
        : null;
    }

    case 'unary': {
      const operand = evaluateExpression(node.operand, scope);
      if (node.operator === 'not') return operand !== true;
      const number = asNumber(operand);
      return number === null ? null : -number;
    }

    case 'call': {
      const args = node.args.map((arg) => asNumber(evaluateExpression(arg, scope)));
      if (node.name === 'round') {
        if (args[0] === null) return null;
        const factor = 10 ** Math.min(Math.max(Math.trunc(args[1] ?? 0), 0), 6);
        return Math.round(args[0] * factor) / factor;
      }
      if (args.some((arg) => arg === null)) return null;
      const numbers = args as number[];
      switch (node.name) {
        case 'sum':
          return numbers.reduce((total, value) => total + value, 0);
        case 'avg':
          return numbers.reduce((total, value) => total + value, 0) / numbers.length;
        case 'min':
          return Math.min(...numbers);
        case 'max':
          return Math.max(...numbers);
        case 'abs':
          return Math.abs(numbers[0]);
      }
      return null;
    }

    case 'binary': {
      if (node.operator === 'and') {
        return (
          evaluateExpression(node.left, scope) === true &&
          evaluateExpression(node.right, scope) === true
        );
      }
      if (node.operator === 'or') {
        return (
          evaluateExpression(node.left, scope) === true ||
          evaluateExpression(node.right, scope) === true
        );
      }

      const left = evaluateExpression(node.left, scope);
      const right = evaluateExpression(node.right, scope);

      if (node.operator === '==' || node.operator === '!=') {
        if (left === null || right === null) return false;
        return node.operator === '==' ? left === right : left !== right;
      }

      const a = asNumber(left);
      const b = asNumber(right);
      const isComparison = ['>', '>=', '<', '<='].includes(node.operator);
      if (a === null || b === null) return isComparison ? false : null;

      switch (node.operator) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? null : a / b;
        case '^': {
          const result = a ** b;
          return Number.isFinite(result) ? result : null;
        }
        case '>':
          return a > b;
        case '>=':
          return a >= b;
        case '<':
          return a < b;
        case '<=':
          return a <= b;
      }
    }
  }
  return null;
}
