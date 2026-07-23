/**
 * MySQL schema introspection from information_schema. Covers tables, views,
 * columns + types + defaults + generated + comments, PKs, FKs, uniques,
 * indexes, triggers, routines, and enum column values (INT-*).
 *
 * Permission-tolerant: each section is read behind a `safe` wrapper, so an
 * information_schema view the connecting user cannot read is simply absent and
 * recorded as a warning rather than throwing.
 *
 * introspectMysql fetches the rows and (opt-in) samples column values;
 * buildMysqlCatalog is the pure assembly of those rows into a SchemaCatalog.
 */

import {
  VALUE_SAMPLE_MAX_DISTINCT,
  type ColumnInfo,
  type ForeignKeyInfo,
  type IndexInfo,
  type RoutineInfo,
  type SchemaCatalog,
  type TableInfo,
  type TriggerInfo,
} from '@asksql/core';

/** Object-mode reader for information_schema queries (the connector's pool). */
export interface MysqlQueryable {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

// Value sampling (opt-in) guards: bound the per-column scan, the total number of
// columns probed per introspect, and how long a sampled value may be.
const SAMPLE_QUERY_TIMEOUT_MS = 2000;
const MAX_SAMPLED_COLUMNS = 300;
const MAX_SAMPLE_VALUE_LEN = 64;

/** Only fixed-length text is worth sampling; text/blob/json/enum/set are not. */
function isSampleableMysqlType(dbType: string): boolean {
  return /^(var)?char\s*\(/i.test(dbType.trim());
}

function backtick(ident: string): string {
  return `\`${ident.replace(/`/g, '``')}\``;
}

/** Parse the comma-separated quoted labels of an `enum(...)` COLUMN_TYPE. */
function parseEnumValues(colType: string): string[] | undefined {
  const enumMatch = /^enum\((.*)\)$/i.exec(colType);
  return enumMatch
    ? enumMatch[1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, '').replace(/''/g, "'"))
    : undefined;
}

/** Key for the sampled-values map: table + column joined by a NUL, which no
 * identifier can contain, so it is collision-proof within a schema. */
function sampleKey(table: string, column: string): string {
  return `${table}\u0000${column}`;
}

/**
 * Distinct values of one short text column, or undefined when the column is
 * not categorical (too many distinct values, or any value is long). Bounded by
 * LIMIT + a MAX_EXECUTION_TIME hint so a big table cannot stall introspection.
 */
async function sampleColumn(
  db: MysqlQueryable,
  database: string,
  table: string,
  column: string,
): Promise<string[] | undefined> {
  const rows = await db.query(
    `SELECT /*+ MAX_EXECUTION_TIME(${SAMPLE_QUERY_TIMEOUT_MS}) */ DISTINCT ${backtick(column)} AS v ` +
      `FROM ${backtick(database)}.${backtick(table)} ` +
      `WHERE ${backtick(column)} IS NOT NULL LIMIT ${VALUE_SAMPLE_MAX_DISTINCT + 1}`,
  );
  if (rows.length > VALUE_SAMPLE_MAX_DISTINCT) return undefined;
  const vals: string[] = [];
  for (const r of rows) {
    if (r['v'] == null) continue;
    const s = String(r['v']);
    if (s.length > MAX_SAMPLE_VALUE_LEN) return undefined;
    vals.push(s);
  }
  return vals.length > 0 ? vals : undefined;
}

/**
 * Opt-in: sample distinct codes of each short non-enum text column on a base
 * table (never views). Bounded by MAX_SAMPLED_COLUMNS; a locked-down, huge, or
 * slow column simply gets no samples. Returns table+column -> distinct values.
 */
async function sampleMysqlColumns(
  db: MysqlQueryable,
  database: string,
  rows: MysqlIntrospectRows,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const viewNames = new Set(rows.views.map((v) => String(v['TABLE_NAME'])));
  let budget = MAX_SAMPLED_COLUMNS;
  // COLUMNS rows arrive ordered by table then ordinal, so a flat pass visits
  // each table's columns contiguously - the same order as grouping first.
  for (const c of rows.cols) {
    if (budget <= 0) break;
    const table = String(c['TABLE_NAME']);
    if (viewNames.has(table)) continue;
    const colType = String(c['COLUMN_TYPE']);
    if (parseEnumValues(colType) || !isSampleableMysqlType(colType)) continue;
    budget--;
    const column = String(c['COLUMN_NAME']);
    try {
      const sampled = await sampleColumn(db, database, table, column);
      if (sampled) out.set(sampleKey(table, column), sampled);
    } catch {
      // Best-effort: a locked-down, huge, or slow column just gets no samples.
    }
  }
  return out;
}

export async function introspectMysql(
  db: MysqlQueryable,
  opts: { database: string; sampleColumnValues: boolean },
): Promise<SchemaCatalog> {
  const database = opts.database;
  const warnings: string[] = [];
  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`Could not read ${label}: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  };

  const cols = await safe(
    'columns',
    () =>
      db.query(
        `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
              COLUMN_COMMENT, EXTRA, COLUMN_KEY
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [database],
      ),
    [],
  );

  const tablesMeta = await safe(
    'tables',
    () =>
      db.query(
        `SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
        [database],
      ),
    [],
  );

  const views = await safe(
    'views',
    () =>
      db.query(`SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`, [database]),
    [],
  );

  const keyCols = await safe(
    'key columns',
    () =>
      db.query(
        `SELECT TABLE_NAME, COLUMN_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, ORDINAL_POSITION
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
        [database],
      ),
    [],
  );

  const stats = await safe(
    'indexes',
    () =>
      db.query(
        `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        [database],
      ),
    [],
  );

  const trg = await safe(
    'triggers',
    () =>
      db.query(
        `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT
       FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?`,
        [database],
      ),
    [],
  );

  const routines = await safe(
    'routines',
    () =>
      db.query(
        `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, IS_DETERMINISTIC, DATA_TYPE
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
        [database],
      ),
    [],
  );

  const rows: MysqlIntrospectRows = { cols, tablesMeta, views, keyCols, stats, trg, routines };
  const sampledValues = opts.sampleColumnValues ? await sampleMysqlColumns(db, database, rows) : undefined;
  return buildMysqlCatalog(database, rows, warnings, sampledValues);
}

/** Row sets fetched from information_schema, as introspectMysql queries them. */
export interface MysqlIntrospectRows {
  readonly cols: readonly Record<string, unknown>[];
  readonly tablesMeta: readonly Record<string, unknown>[];
  readonly views: readonly Record<string, unknown>[];
  readonly keyCols: readonly Record<string, unknown>[];
  readonly stats: readonly Record<string, unknown>[];
  readonly trg: readonly Record<string, unknown>[];
  readonly routines: readonly Record<string, unknown>[];
}

/**
 * Pure assembly of a SchemaCatalog from already-fetched information_schema rows.
 * `sampledValues` (table+column -> distinct codes) is attached to matching
 * columns when present.
 */
export function buildMysqlCatalog(
  database: string,
  rows: MysqlIntrospectRows,
  warnings: string[] = [],
  sampledValues?: Map<string, string[]>,
): SchemaCatalog {
  const viewDef = new Map(
    rows.views.map((v) => [
      String(v['TABLE_NAME']),
      v['VIEW_DEFINITION'] == null ? null : String(v['VIEW_DEFINITION']),
    ]),
  );

  // Assemble columns
  const columnsByTable = new Map<string, ColumnInfo[]>();
  for (const c of rows.cols) {
    const t = String(c['TABLE_NAME']);
    let list = columnsByTable.get(t);
    if (!list) columnsByTable.set(t, (list = []));
    const colType = String(c['COLUMN_TYPE']);
    const enumValues = parseEnumValues(colType);
    const name = String(c['COLUMN_NAME']);
    const sampled = enumValues ? undefined : sampledValues?.get(sampleKey(t, name));
    list.push({
      name,
      dbType: colType,
      nullable: String(c['IS_NULLABLE']).toUpperCase() === 'YES',
      default: c['COLUMN_DEFAULT'] == null ? null : String(c['COLUMN_DEFAULT']),
      generated: /GENERATED/i.test(String(c['EXTRA'] ?? '')),
      comment: c['COLUMN_COMMENT'] ? String(c['COLUMN_COMMENT']) : null,
      ...(enumValues ? { enumValues } : {}),
      ...(sampled ? { sampledValues: sampled } : {}),
    });
  }

  // PK + FK from KEY_COLUMN_USAGE
  const pkByTable = new Map<string, string[]>();
  const fkByTable = new Map<string, ForeignKeyInfo[]>();
  const fkGroups = new Map<string, { table: string; cols: string[]; refTable: string; refCols: string[] }>();
  for (const k of rows.keyCols) {
    const table = String(k['TABLE_NAME']);
    const con = String(k['CONSTRAINT_NAME']);
    const col = String(k['COLUMN_NAME']);
    if (con === 'PRIMARY') {
      const arr = pkByTable.get(table) ?? [];
      arr.push(col);
      pkByTable.set(table, arr);
    } else if (k['REFERENCED_TABLE_NAME']) {
      const gk = `${table}.${con}`;
      let g = fkGroups.get(gk);
      if (!g) fkGroups.set(gk, (g = { table, cols: [], refTable: String(k['REFERENCED_TABLE_NAME']), refCols: [] }));
      g.cols.push(col);
      g.refCols.push(String(k['REFERENCED_COLUMN_NAME']));
    }
  }
  for (const g of fkGroups.values()) {
    const arr = fkByTable.get(g.table) ?? [];
    arr.push({ columns: g.cols, refTable: g.refTable, refColumns: g.refCols });
    fkByTable.set(g.table, arr);
  }

  // Indexes
  const idxByTable = new Map<string, Map<string, IndexInfo & { cols: string[] }>>();
  for (const s of rows.stats) {
    const table = String(s['TABLE_NAME']);
    const idxName = String(s['INDEX_NAME']);
    let m = idxByTable.get(table);
    if (!m) idxByTable.set(table, (m = new Map()));
    let ix = m.get(idxName);
    if (!ix)
      m.set(
        idxName,
        (ix = {
          name: idxName,
          columns: [],
          cols: [],
          unique: Number(s['NON_UNIQUE']) === 0,
          method: String(s['INDEX_TYPE'] ?? ''),
        }),
      );
    ix.cols.push(String(s['COLUMN_NAME']));
  }

  const tables: TableInfo[] = rows.tablesMeta.map((tm) => {
    const name = String(tm['TABLE_NAME']);
    const isView = String(tm['TABLE_TYPE']).toUpperCase() === 'VIEW';
    const idxMap = idxByTable.get(name);
    const indexes: IndexInfo[] = idxMap
      ? [...idxMap.values()].map((i) => ({ name: i.name, columns: i.cols, unique: i.unique, method: i.method }))
      : [];
    return {
      name,
      kind: isView ? 'view' : 'table',
      columns: columnsByTable.get(name) ?? [],
      primaryKey: pkByTable.get(name) ?? [],
      foreignKeys: fkByTable.get(name) ?? [],
      uniques: indexes.filter((i) => i.unique && i.name !== 'PRIMARY').map((i) => i.columns),
      checks: [],
      indexes,
      comment: tm['TABLE_COMMENT'] ? String(tm['TABLE_COMMENT']) : null,
      rowEstimate: tm['TABLE_ROWS'] == null ? null : Number(tm['TABLE_ROWS']),
      definition: isView ? (viewDef.get(name) ?? null) : null,
      source: 'db',
    };
  });

  const triggers: TriggerInfo[] = rows.trg.map((t) => ({
    name: String(t['TRIGGER_NAME']),
    table: String(t['EVENT_OBJECT_TABLE']),
    timing: normalizeTiming(t['ACTION_TIMING']),
    events: [String(t['EVENT_MANIPULATION'])],
    enabled: true,
    definition: t['ACTION_STATEMENT'] ? String(t['ACTION_STATEMENT']) : null,
  }));

  const routineInfos: RoutineInfo[] = rows.routines.map((r) => ({
    name: String(r['ROUTINE_NAME']),
    kind: String(r['ROUTINE_TYPE']).toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
    args: '',
    returns: r['DTD_IDENTIFIER'] ? String(r['DTD_IDENTIFIER']) : null,
    // MySQL doesn't expose PG-style volatility; treat deterministic funcs as
    // stable (callable), everything else as unknown (listed, not called).
    volatility: String(r['IS_DETERMINISTIC']).toUpperCase() === 'YES' ? 'stable' : 'unknown',
  }));

  return {
    engine: 'mysql',
    schemas: [database],
    tables,
    enums: [],
    sequences: [],
    triggers,
    routines: routineInfos,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeTiming(v: unknown): TriggerInfo['timing'] {
  const t = String(v ?? '').toUpperCase();
  return t === 'BEFORE' || t === 'AFTER' || t === 'INSTEAD OF' ? t : 'UNKNOWN';
}
