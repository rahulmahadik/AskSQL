/**
 * Semantic lints: SQL the guard allows because it is read-only, but that answers the wrong
 * question. The guard decides what may run; this decides what is worth running.
 * Deliberately narrow - each check fires only on a shape that is unambiguously a mistake.
 */

import pkg from 'node-sql-parser';
import { withoutFetchTail } from './strip.js';

const { Parser } = pkg as unknown as {
  Parser: new () => { parse: (sql: string, opts: { database: string }) => { ast: unknown } };
};
const parser = new Parser();

const AGGREGATES = new Set(['count', 'sum', 'avg', 'min', 'max', 'group_concat', 'string_agg', 'array_agg']);

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;

/** SQLite's `max(a, b)` / `min(a, b)` are per-row scalars, not aggregates. */
function argCount(node: Node): number {
  const args = node['args'];
  if (!isNode(args)) return 0;
  const value = args['value'] ?? args['expr'];
  if (Array.isArray(value)) return value.length;
  return value === undefined ? 0 : 1;
}

/** An aggregate call that is NOT windowed: `count(*) OVER (...)` needs no GROUP BY. */
function isBareAggregate(node: Node): boolean {
  const type = node['type'];
  if (type !== 'aggr_func' && type !== 'function') return false;
  if (node['over']) return false;
  const name = node['name'];
  const text =
    typeof name === 'string'
      ? name
      : isNode(name) && Array.isArray(name['name'])
        ? String((name['name'][0] as Node)?.['value'] ?? '')
        : '';
  const fn = text.toLowerCase();
  if (!AGGREGATES.has(fn)) return false;
  // Multi-argument min/max is SQLite's scalar form and needs no GROUP BY.
  if ((fn === 'min' || fn === 'max') && argCount(node) > 1) return false;
  return true;
}

/** Walks one expression, reporting whether it contains a bare aggregate and/or a bare column. */
function inspect(node: unknown, found: { aggregate: boolean; column: boolean }, insideAggregate = false): void {
  if (Array.isArray(node)) {
    for (const child of node) inspect(child, found, insideAggregate);
    return;
  }
  if (!isNode(node)) return;

  // A subquery answers its own question; its columns do not belong to this one.
  if (node['type'] === 'select') return;

  if (isBareAggregate(node)) {
    found.aggregate = true;
    inspect(node['args'], found, true);
    return;
  }
  if (node['type'] === 'column_ref' && !insideAggregate) found.column = true;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'over') continue; // a window spec's columns are not select-list columns
    inspect(value, found, insideAggregate);
  }
}

/**
 * `SELECT status, count(*) FROM orders` with no GROUP BY: rejected by PostgreSQL and strict MySQL,
 * and silently wrong in SQLite. Returns the column that needs grouping, or null.
 */
export function ungroupedAggregate(sql: string, grammar: string): string | null {
  let ast: unknown;
  try {
    // The Oracle row cap is a tail this parser cannot read, and this check fails open.
    ast = parser.parse(withoutFetchTail(sql), { database: grammar }).ast;
  } catch {
    return null; // the guard already fails closed on unparsable SQL; never double-report here
  }
  // node-sql-parser chains UNION/INTERSECT/EXCEPT arms on `_next`, so the chain is flattened.
  const statements: unknown[] = [];
  const queue: unknown[] = Array.isArray(ast) ? [...ast] : [ast];
  while (queue.length > 0) {
    const node = queue.shift();
    statements.push(node);
    if (isNode(node) && node['_next']) queue.push(node['_next']);
  }
  for (const statement of statements) {
    if (!isNode(statement) || statement['type'] !== 'select') continue;
    if (statement['groupby']) continue;
    const columns = statement['columns'];
    if (!Array.isArray(columns)) continue;

    const found = { aggregate: false, column: false };
    let firstColumn: string | null = null;
    for (const entry of columns) {
      const expr = isNode(entry) ? entry['expr'] : entry;
      const before = found.column;
      inspect(expr, found);
      if (!before && found.column && firstColumn === null) {
        firstColumn = columnNameOf(expr) ?? 'that column';
      }
    }
    if (found.aggregate && found.column) return firstColumn ?? 'that column';
  }
  return null;
}

/** Best-effort name for the reported column, across node-sql-parser shape variants. */
function columnNameOf(expr: unknown): string | null {
  if (!isNode(expr)) return null;
  if (expr['type'] === 'column_ref') {
    const column = expr['column'];
    if (typeof column === 'string') return column;
    if (isNode(column) && typeof column['expr'] === 'object' && isNode(column['expr'])) {
      const value = (column['expr'] as Node)['value'];
      if (typeof value === 'string') return value;
    }
    return null;
  }
  for (const value of Object.values(expr)) {
    const name = columnNameOf(value);
    if (name) return name;
  }
  return null;
}

export interface FanOut {
  readonly column: string;
  readonly parent: string;
  readonly child: string;
}

interface FanOutCatalog {
  readonly tables: readonly {
    readonly name: string;
    readonly foreignKeys: readonly { readonly refTable: string }[];
  }[];
}

const same = (a: string | undefined, b: string | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Every table named in FROM and its JOINs, keyed by the alias the query uses. */
function fromTables(statement: Node): { alias: string; table: string }[] {
  const from = statement['from'];
  if (!Array.isArray(from)) return [];
  const out: { alias: string; table: string }[] = [];
  for (const item of from) {
    if (!isNode(item)) continue;
    const table = item['table'];
    if (typeof table !== 'string') continue;
    out.push({ alias: typeof item['as'] === 'string' ? item['as'] : table, table });
  }
  return out;
}

/** Qualified columns under a bare SUM/AVG. DISTINCT and COUNT are exempt. */
function collectSums(node: unknown, found: { table: string; column: string }[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectSums(child, found);
    return;
  }
  if (!isNode(node)) return;
  if (node['type'] === 'select') return;
  const name = typeof node['name'] === 'string' ? node['name'].toLowerCase() : '';
  if (node['type'] === 'aggr_func' && (name === 'sum' || name === 'avg') && !node['over']) {
    const args = node['args'];
    if (isNode(args) && !args['distinct']) {
      const expr = args['expr'];
      if (isNode(expr) && expr['type'] === 'column_ref' && typeof expr['table'] === 'string') {
        const column = expr['column'];
        const value = isNode(column) && isNode(column['expr']) ? (column['expr'] as Node)['value'] : column;
        if (typeof value === 'string') found.push({ table: expr['table'], column: value });
      }
    }
    return;
  }
  for (const value of Object.values(node)) collectSums(value, found);
}

/** `SUM(a.x)` over a table joined to its own children counts x once per child row. */
export function fanOutAggregate(sql: string, grammar: string, catalog: FanOutCatalog): FanOut | null {
  let ast: unknown;
  try {
    ast = parser.parse(withoutFetchTail(sql), { database: grammar }).ast;
  } catch {
    return null;
  }
  const statements: unknown[] = Array.isArray(ast) ? [...ast] : [ast];
  for (const statement of statements) {
    if (!isNode(statement) || statement['type'] !== 'select') continue;
    const tables = fromTables(statement);
    if (tables.length < 2) continue;

    const sums: { table: string; column: string }[] = [];
    collectSums(statement['columns'], sums);

    for (const sum of sums) {
      const parent = tables.find((t) => same(t.alias, sum.table) || same(t.table, sum.table))?.table;
      if (!parent) continue;
      for (const candidate of tables) {
        if (same(candidate.table, parent)) continue;
        const child = catalog.tables.find((t) => same(t.name, candidate.table));
        if (child?.foreignKeys.some((fk) => same(fk.refTable, parent))) {
          return { column: sum.column, parent, child: candidate.table };
        }
      }
    }
  }
  return null;
}

/**
 * An aggregate nested inside another aggregate, like AVG(x + SUM(y)). Every engine rejects it, so
 * catching it before execution turns a database error into a repair. Returns the outer function name.
 */
export function nestedAggregate(sql: string, grammar: string): string | null {
  let ast: unknown;
  try {
    ast = parser.parse(withoutFetchTail(sql), { database: grammar }).ast;
  } catch {
    return null; // the guard already parsed it; never double-block here
  }

  let outer: string | null = null;
  const walk = (node: unknown, insideAggregate: string | null): void => {
    if (outer) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, insideAggregate);
      return;
    }
    if (!isNode(node)) return;
    const isAgg = isBareAggregate(node);
    if (isAgg && insideAggregate) {
      outer = insideAggregate;
      return;
    }
    const within = isAgg ? aggregateName(node) : insideAggregate;
    for (const key of Object.keys(node)) {
      // A subquery has its own scope, so an aggregate inside one is not nested in the outer call.
      if (key === 'ast' || key === 'from') continue;
      walk(node[key], within);
    }
  };
  walk(ast, null);
  return outer;
}

function aggregateName(node: Node): string {
  const name = node['name'];
  const text =
    typeof name === 'string'
      ? name
      : isNode(name) && Array.isArray(name['name'])
        ? String((name['name'][0] as Node)?.['value'] ?? '')
        : '';
  return text.toUpperCase();
}

/** A comparison whose two sides cannot mean the same thing: an integer column against a date. */
export interface EpochMismatch {
  /** The column as the catalog spells it. */
  readonly column: string;
  readonly dbType: string;
  /** The date expression it was compared against, rendered for the message. */
  readonly comparedTo: string;
}

interface TypedCatalog {
  readonly tables: readonly {
    readonly name: string;
    readonly columns: readonly { readonly name: string; readonly dbType?: string }[];
  }[];
}

/**
 * A column that stores a moment as a number: SQLite has no date type, so Room writes epoch
 * milliseconds into INTEGER, and a hand-rolled schema may write epoch seconds.
 */
const INTEGER_DB_TYPE =
  /^(?:big\s*int|int|integer|int2|int4|int8|smallint|tinyint|mediumint|unsigned\s+big\s+int|numeric|number)\b/i;

/** SQLite's date builders, plus the standard keywords. All of them produce text or a day number. */
const DATE_FUNCTION =
  /^(?:date|datetime|time|strftime|julianday|unixepoch|current_date|current_time|current_timestamp|now|getdate|sysdate)$/i;

/** A literal a person writes for a day or an instant, which is text however it is compared. */
const DATE_LITERAL = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;

function renderDateSide(node: Node): string | null {
  const type = node['type'];
  if (type === 'function' || type === 'aggr_func') {
    const name = aggregateName(node);
    return DATE_FUNCTION.test(name) ? `${name}(...)` : null;
  }
  // CURRENT_DATE and friends arrive as a bare keyword rather than a call.
  if (type === 'origin' || type === 'keyword') {
    const value = node['value'];
    return typeof value === 'string' && DATE_FUNCTION.test(value.replace(/\s+/g, '_')) ? value : null;
  }
  if (type === 'single_quote_string' || type === 'string') {
    const value = node['value'];
    return typeof value === 'string' && DATE_LITERAL.test(value.trim()) ? `'${value}'` : null;
  }
  // date('now','-7 days') nested under a cast, or strftime wrapped in one.
  if (type === 'cast' && isNode(node['expr'])) return renderDateSide(node['expr'] as Node);
  return null;
}

/** The catalog type of a column named anywhere in the query, or null when it is not attributable. */
function dbTypeOf(column: string, catalog: TypedCatalog): string | null {
  const matches: string[] = [];
  for (const table of catalog.tables) {
    for (const c of table.columns) {
      if (c.name.toLowerCase() === column.toLowerCase() && typeof c.dbType === 'string') matches.push(c.dbType);
    }
  }
  // Two tables typing the same name differently is not attributable from the name alone.
  if (matches.length === 0) return null;
  const first = matches[0]!;
  return matches.every((m) => m.toLowerCase() === first.toLowerCase()) ? first : null;
}

/**
 * A column holding a number compared against a date. Against text nothing matches and zero is reported;
 * against epoch seconds a milliseconds column matches every row. Neither errors.
 */
export function epochUnitMismatch(sql: string, grammar: string, catalog: TypedCatalog): EpochMismatch | null {
  let ast: unknown;
  try {
    ast = parser.parse(withoutFetchTail(sql), { database: grammar }).ast;
  } catch {
    return null;
  }

  let found: EpochMismatch | null = null;
  const visit = (node: unknown): void => {
    if (found || !isNode(node)) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node['type'] === 'binary_expr') {
      const left = node['left'];
      const right = node['right'];
      for (const [maybeColumn, maybeDate] of [
        [left, right],
        [right, left],
      ] as const) {
        if (!isNode(maybeColumn) || maybeColumn['type'] !== 'column_ref') continue;
        const column = columnNameOf(maybeColumn);
        if (!column) continue;
        const dbType = dbTypeOf(column, catalog);
        if (!dbType || !INTEGER_DB_TYPE.test(dbType.trim())) continue;
        // BETWEEN carries its bounds as a list; either bound being a date is the same mistake.
        const candidates =
          isNode(maybeDate) && Array.isArray(maybeDate['value']) ? (maybeDate['value'] as unknown[]) : [maybeDate];
        for (const candidate of candidates) {
          const rendered = isNode(candidate) ? renderDateSide(candidate as Node) : null;
          if (rendered) {
            found = { column, dbType, comparedTo: rendered };
            return;
          }
        }
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(ast);
  return found;
}
