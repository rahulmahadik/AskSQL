/**
 * Structure questions answered with SQL written here rather than guessed by a model, which has never
 * seen the system catalogs and invents columns on `information_schema` and `pg_stat_*`.
 *
 * Always a statement, never a cached answer: the catalog supplies only names, and it can be minutes
 * stale where a query cannot. Matching is narrow, since hijacking a data question is worse than
 * missing one of these.
 */

import type { DialectInfo, EngineKind, SchemaCatalog, TableInfo } from './types.js';

export interface CatalogQuery {
  readonly sql: string;
  /** Shown in place of the model's explanation, since no model wrote this. */
  readonly explanation: string;
}

const EVERY_TABLE = /\b(each|every|per|all)\s+(?:the\s+)?tables?\b/i;
const ROWS = /\b(rows?|records?)\b/i;
const MOST_ROWS =
  /\b(most|largest|biggest|highest)\b[^.?!]{0,24}\b(rows?|records?)\b|\b(rows?|records?)\b[^.?!]{0,24}\b(most|largest|biggest)\b/i;
const NEGATED = /\b(without|no|missing|lack(?:ing|s)?|do(?:es)?\s*n[o']?t have|have no)\b/i;
const TABLES = /\btables?\b/i;
const PRIMARY_KEY = /\bprimary\s+keys?\b|\bpk\b/i;
/** "the orders table" names one table, so the question is about its rows, not about every table. */
/** The subject has to be tables. "which rows ... have no pk" asks about rows in one table. */
const TABLE_SUBJECT = /\b(?:which|what|list|show|find|any)\b[^.?!]{0,24}\btables?\b/i;
const ROW_SUBJECT = /\b(?:rows?|records?)\b/i;

const NAMED_TABLE = /\b(?:the|this|that|a|an|our|my)\s+[\w"`\]]+\s+tables?\b/i;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const qualified = (t: TableInfo): string => (t.schema ? `${t.schema}.${t.name}` : t.name);

/** Views have no rows of their own, and a partition is counted through its parent. */
const countableTables = (catalog: SchemaCatalog): TableInfo[] =>
  catalog.tables.filter((t) => t.kind === 'table' && !t.partitionOf);

function quoteFor(name: string, dialect: DialectInfo): string {
  const q = dialect.quoteChar;
  return `${q}${name.split(q).join(q + q)}${q}`;
}

/**
 * Tables with no primary key, in each engine's own catalog. Written per engine because this is
 * exactly where a model guesses: the shapes differ, and only Oracle and MySQL expose it simply.
 */
function tablesWithoutPrimaryKey(engine: EngineKind, schemas: readonly string[]): string | null {
  // The catalog spans every schema introspected, so answering for current_schema() alone reports a
  // narrower truth than the schema tree the reader is looking at.
  // With no schema on the catalog's tables there is nothing better than the session's own.
  const inList = schemas.length > 0 ? schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ') : 'current_schema()';
  switch (engine) {
    case 'postgres':
      return `SELECT t.table_name
FROM information_schema.tables t
WHERE t.table_schema IN (${inList})
  AND t.table_type = 'BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints c
    WHERE c.table_schema = t.table_schema
      AND c.table_name = t.table_name
      AND c.constraint_type = 'PRIMARY KEY'
  )
ORDER BY t.table_name`;
    case 'mysql':
      return `SELECT t.TABLE_NAME
FROM information_schema.TABLES t
WHERE t.TABLE_SCHEMA = DATABASE()
  AND t.TABLE_TYPE = 'BASE TABLE'
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS c
    WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA
      AND c.TABLE_NAME = t.TABLE_NAME
      AND c.CONSTRAINT_TYPE = 'PRIMARY KEY'
  )
ORDER BY t.TABLE_NAME`;
    case 'oracle':
      return `SELECT t.table_name
FROM user_tables t
WHERE NOT EXISTS (
  SELECT 1 FROM user_constraints c
  WHERE c.table_name = t.table_name AND c.constraint_type = 'P'
)
ORDER BY t.table_name`;
    case 'sqlite':
      // sqlite_master has no constraint view; pragma_table_info exposes the key flag per column.
      return `SELECT m.name
FROM sqlite_master m
WHERE m.type = 'table'
  AND m.name NOT LIKE 'sqlite_%'
  AND NOT EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.pk > 0)
ORDER BY m.name`;
    default:
      return null; // DuckDB and anything else: let the model try rather than guess a shape here
  }
}

/**
 * Returns a statement for the structure questions worth writing exactly, or null for everything
 * else, which is the common case.
 */
export function catalogQueryFor(question: string, catalog: SchemaCatalog, dialect: DialectInfo): CatalogQuery | null {
  const q = question.trim();
  // Only Postgres needs this: MySQL's DATABASE() and SQLite's file are already the whole catalog,
  // and Oracle is introspected for one owner.
  const schemas = [...new Set(catalog.tables.map((t) => t.schema).filter((x): x is string => !!x))];
  if (!TABLES.test(q)) return null;

  if (NEGATED.test(q) && PRIMARY_KEY.test(q) && TABLE_SUBJECT.test(q) && !ROW_SUBJECT.test(q)) {
    const sql = tablesWithoutPrimaryKey(dialect.engine, schemas);
    if (sql) {
      return { sql, explanation: 'Lists tables with no primary key, read from the database catalog.' };
    }
  }

  // Row counts, one branch per table: a model writes this as an information_schema join and gets an
  // ambiguous column. Naming a table makes it a data question about that table's rows instead.
  if (NAMED_TABLE.test(q) || catalog.tables.some((t) => new RegExp(`\\b${escapeRe(t.name)}\\b`, 'i').test(q))) {
    return null;
  }
  // A condition on the rows ("...that have no pk", "...where status is null") makes it a data
  // question about rows, not a count of every table.
  if (NEGATED.test(q) || /\b(?:where|that (?:are|have)|with a|having)\b/i.test(q)) return null;
  if ((EVERY_TABLE.test(q) && ROWS.test(q)) || MOST_ROWS.test(q)) {
    const tables = countableTables(catalog);
    if (tables.length === 0) return null;
    const branches = tables.map((t) => {
      const label = qualified(t).replace(/'/g, "''");
      const from = t.schema ? `${quoteFor(t.schema, dialect)}.${quoteFor(t.name, dialect)}` : quoteFor(t.name, dialect);
      return `SELECT '${label}' AS table_name, COUNT(*) AS row_count FROM ${from}`;
    });
    const body = branches.join('\nUNION ALL\n');
    // Always ordered: the guard appends its row cap, and an unordered UNION ALL truncated to the cap
    // drops tables at random while the explanation claims to have counted them all.
    return {
      sql: `SELECT * FROM (\n${body}\n) counts ORDER BY row_count DESC`,
      explanation: `Counts the rows in each of the ${tables.length} tables, largest first.`,
    };
  }

  return null;
}
