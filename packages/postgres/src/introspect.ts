/**
 * PostgreSQL schema introspection from pg_catalog: tables, views, matviews, columns, PKs,
 * FKs, unique & check constraints, indexes, triggers, functions with volatility, enums,
 * sequences, partitions, extensions. Objects the connecting role cannot read are absent
 * rather than fatal, so nothing here throws on a locked-down schema.
 */

import {
  epochUnitOf,
  HINT_VALUE_CAP,
  isMomentColumn,
  isJsonCandidateColumn,
  jsonHint,
  jsonShapeOf,
  jsonArrayElementOf,
  JSON_SAMPLE_ROWS,
  MAX_HINT_PROBES,
  MAX_HINT_PROBES_PER_TABLE,
} from '@asksql/core';
import type {
  ColumnInfo,
  EnumTypeInfo,
  ForeignKeyInfo,
  IndexInfo,
  RoutineInfo,
  SchemaCatalog,
  SequenceInfo,
  TableInfo,
  TriggerInfo,
} from '@asksql/core';
import { VALUE_SAMPLE_MAX_DISTINCT } from '@asksql/core';

interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** Pools expose this; used to bound value sampling on a dedicated client. */
  connect?(): Promise<QueryableClient>;
}

interface QueryableClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] | unknown[][] }>;
  release(): void;
}

/** Object-mode reader for a single sample SELECT (pool or dedicated client). */
type SampleRunner = {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] | unknown[][] }>;
};

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

// Value sampling (opt-in) guards: columns probed per introspect, value length, per-scan runtime.
const MAX_SAMPLED_COLUMNS = 300;
const MAX_SAMPLE_VALUE_LEN = 64;
const SAMPLE_STATEMENT_TIMEOUT_MS = 2000;

/** Text-ish types worth sampling; numeric/uuid/json/temporal/name are not. */
function isSampleablePgType(dbType: string): boolean {
  return /^(character varying|varchar|character|char|bpchar|text|citext)\b/i.test(dbType.trim());
}

function quotePg(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Distinct values of one short text column, or undefined when it is not categorical
 * (too many distinct values, or any value is long). LIMIT bounds the result.
 */
async function samplePgColumn(
  db: SampleRunner,
  schema: string,
  table: string,
  column: string,
): Promise<string[] | undefined> {
  const res = await db.query(
    `SELECT DISTINCT ${quotePg(column)} AS v FROM ${quotePg(schema)}.${quotePg(table)} ` +
      `WHERE ${quotePg(column)} IS NOT NULL LIMIT ${VALUE_SAMPLE_MAX_DISTINCT + 1}`,
  );
  const rows = res.rows as Record<string, unknown>[];
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

/** `->>` and `@>` exist on json/jsonb only; a text column holding JSON needs the cast or the hint
 * suggests SQL that cannot run. */
function jsonRef(col: { name: string; dbType: string }): string {
  // Quoted like the probe: unquoted, a mixed-case name folds and the expression fails.
  const ref = quotePg(col.name);
  return /^jsonb?$/i.test(col.dbType.trim()) ? ref : `(${ref})::jsonb`;
}

/**
 * States what a Postgres column's type leaves out: the unit of an integer timestamp, and the keys inside
 * a json/jsonb column. Measured before this existed: "events finished after 1 August" compared epoch
 * MILLISECONDS against epoch seconds and matched every row (3 returned, 2 true), with no error; and a
 * question about a jsonb field the model could not name was abstained on entirely.
 *
 * Structure only - a unit from an aggregate, key names that recur. No cell value is stated.
 */
async function withPgColumnHints(db: SampleRunner, tables: TableInfo[], nameKeys: boolean): Promise<TableInfo[]> {
  let total = MAX_HINT_PROBES;
  const out: TableInfo[] = [];
  for (const table of tables) {
    if (table.kind !== 'table' || total <= 0) {
      out.push(table);
      continue;
    }
    const rel = `${quotePg(table.schema ?? 'public')}.${quotePg(table.name)}`;
    // Per table, so filler tables early in the catalog cannot spend every probe.
    let budget = Math.min(MAX_HINT_PROBES_PER_TABLE, total);
    const columns: ColumnInfo[] = [];
    for (const col of table.columns) {
      const moment = isMomentColumn(col.name, col.dbType);
      const isJson = isJsonCandidateColumn(col.dbType);
      if (budget <= 0 || col.comment || (!moment && !isJson)) {
        columns.push(col); // never overwrite a comment the DBA wrote
        continue;
      }
      budget--;
      total--;
      try {
        // Without a savepoint one failed probe aborts the shared transaction and every later one
        // dies with 25P02, undescribed and swallowed.
        await db.query('SAVEPOINT asksql_hint').catch(() => {});
        if (moment) {
          const res = await db.query(
            `SELECT MIN(${quotePg(col.name)}) AS lo, MAX(${quotePg(col.name)}) AS hi FROM ${rel}`,
          );
          const first = (res.rows as Record<string, unknown>[])[0];
          const unit = epochUnitOf(Number(first?.['lo']), Number(first?.['hi']));
          columns.push(unit ? { ...col, comment: unit } : col);
        } else {
          const res = await db.query(
            `SELECT left(${quotePg(col.name)}::text, ${HINT_VALUE_CAP}) AS v FROM ${rel} WHERE ${quotePg(col.name)} IS NOT NULL ` +
              `LIMIT ${JSON_SAMPLE_ROWS}`,
          );
          const vals = (res.rows as Record<string, unknown>[]).map((r) => r['v']);
          const shape = vals.length > 0 ? jsonShapeOf(vals) : null;
          const el = shape ? null : vals.length > 0 ? jsonArrayElementOf(vals) : null;
          columns.push(
            shape
              ? { ...col, comment: jsonHint(`${jsonRef(col)}->>'key'`, shape.keys, nameKeys) }
              : el
                ? {
                    ...col,
                    comment: `JSON array of ${el}s; test membership with ${jsonRef(col)} @> '${el === 'number' ? '1' : '"a"'}'`,
                  }
                : col,
          );
        }
      } catch {
        await db.query('ROLLBACK TO SAVEPOINT asksql_hint').catch(() => {});
        columns.push(col);
      }
    }
    out.push({ ...table, columns });
  }
  return out;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
/** reltuples is -1 on a relation that was never analyzed (and on every plain view): unknown, not empty. */
function rowEstimate(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function introspectPostgres(
  db: Queryable,
  opts?: { includeSystem?: boolean; sampleColumnValues?: boolean },
): Promise<SchemaCatalog> {
  const warnings: string[] = [];
  const includeSystem = opts?.includeSystem ?? false;
  const sysParam = SYSTEM_SCHEMAS;

  const safe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`Could not read ${label}: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  };

  // ---- schemas ----
  const schemaRows = await safe(
    'schemas',
    () =>
      db.query(
        `SELECT nspname FROM pg_namespace n
         WHERE nspname <> ALL($1) AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%'
         ORDER BY nspname`,
        [sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );
  const schemas = schemaRows.rows
    .map((r) => str(r['nspname']))
    .filter((s) => includeSystem || !SYSTEM_SCHEMAS.includes(s));

  // ---- columns (with enum values, comments, generated) ----
  const colRows = await safe(
    'columns',
    () =>
      db.query(
        `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, c.relkind AS relkind,
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS notnull, a.attnum AS ord,
                a.attidentity <> '' OR a.attgenerated <> '' AS generated,
                pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
                col_description(c.oid, a.attnum) AS comment,
                t.typname AS base_type, t.typtype AS typtype
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_type t ON t.oid = a.atttypid
         LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
         WHERE a.attnum > 0 AND NOT a.attisdropped
           AND c.relkind IN ('r','v','m','p','f')
           AND n.nspname <> ALL($1)
         ORDER BY n.nspname, c.relname, a.attnum`,
        [includeSystem ? [] : sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );

  // ---- enums ----
  const enumRows = await safe(
    'enum types',
    () =>
      db.query(
        `SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS label, e.enumsortorder AS ord
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname <> ALL($1)
         ORDER BY n.nspname, t.typname, e.enumsortorder`,
        [includeSystem ? [] : sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );
  const enumsByName = new Map<string, EnumTypeInfo & { values: string[] }>();
  for (const r of enumRows.rows) {
    const key = `${str(r['schema'])}.${str(r['name'])}`;
    let e = enumsByName.get(key);
    if (!e) {
      e = { schema: str(r['schema']), name: str(r['name']), values: [] };
      enumsByName.set(key, e);
    }
    e.values.push(str(r['label']));
  }
  // enum name (bare) -> values, for column typing
  const enumValuesByType = new Map<string, string[]>();
  for (const e of enumsByName.values()) enumValuesByType.set(e.name, e.values);

  // ---- tables / views / matviews meta ----
  const relRows = await safe(
    'relations',
    () =>
      db.query(
        `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
                obj_description(c.oid) AS comment,
                c.reltuples AS row_estimate,
                c.relispartition AS is_partition,
                (SELECT inhparent::regclass::text FROM pg_inherits WHERE inhrelid = c.oid LIMIT 1) AS partition_of,
                CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) ELSE NULL END AS definition,
                c.relkind = 'p' AS is_partitioned
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r','v','m','p','f') AND n.nspname <> ALL($1)
         ORDER BY n.nspname, c.relname`,
        [includeSystem ? [] : sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );

  // ---- primary keys, uniques, checks, foreign keys ----
  const conRows = await safe(
    'constraints',
    () =>
      db.query(
        `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype AS contype,
                pg_get_constraintdef(con.oid) AS def,
                -- WITH ORDINALITY: a join over unnest does not preserve array order, and the two
                -- arrays are paired positionally, so a composite key came back with its columns
                -- matched to the wrong referenced columns.
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum ORDER BY k.ord)::text[] AS cols,
                fn.nspname AS ref_schema, fc.relname AS ref_table,
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid=fc.oid AND a.attnum=k.attnum ORDER BY k.ord)::text[] AS ref_cols
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class fc ON fc.oid = con.confrelid
         LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
         WHERE n.nspname <> ALL($1)
         ORDER BY n.nspname, c.relname`,
        [includeSystem ? [] : sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );

  // ---- indexes ----
  const idxRows = await safe(
    'indexes',
    () =>
      db.query(
        `SELECT n.nspname AS schema, t.relname AS table, i.relname AS name,
                ix.indisunique AS unique, am.amname AS method,
                pg_get_indexdef(ix.indexrelid) AS def,
                pg_get_expr(ix.indpred, ix.indrelid) AS predicate
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_am am ON am.oid = i.relam
         WHERE n.nspname <> ALL($1)
         ORDER BY n.nspname, t.relname, i.relname`,
        [includeSystem ? [] : sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );

  // ---- triggers ----
  const trgRows = await safe(
    'triggers',
    () =>
      db.query(
        `SELECT n.nspname AS schema, c.relname AS table, tg.tgname AS name,
                tg.tgenabled <> 'D' AS enabled,
                pg_get_triggerdef(tg.oid) AS def
         FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT tg.tgisinternal AND n.nspname <> ALL($1)
         ORDER BY n.nspname, c.relname, tg.tgname`,
        [includeSystem ? [] : sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );

  // ---- functions / procedures with volatility ----
  const fnRows = await safe(
    'routines',
    () =>
      db.query(
        `SELECT n.nspname AS schema, p.proname AS name,
                pg_get_function_identity_arguments(p.oid) AS args,
                pg_get_function_result(p.oid) AS returns,
                l.lanname AS language, p.provolatile AS volatility,
                p.prosecdef AS secdef, p.prokind AS kind
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_language l ON l.oid = p.prolang
         WHERE n.nspname <> ALL($1) AND p.prokind IN ('f','p')
         ORDER BY n.nspname, p.proname`,
        [includeSystem ? [] : sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );

  // ---- sequences ----
  const seqRows = await safe(
    'sequences',
    () =>
      db.query(
        `SELECT n.nspname AS schema, c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'S' AND n.nspname <> ALL($1)
         ORDER BY 1,2`,
        [includeSystem ? [] : sysParam],
      ),
    { rows: [] as Record<string, unknown>[] },
  );

  // ---- extensions ----
  const extRows = await safe('extensions', () => db.query(`SELECT extname FROM pg_extension ORDER BY extname`), {
    rows: [] as Record<string, unknown>[],
  });

  // ---- assemble ----
  const volMap: Record<string, RoutineInfo['volatility']> = { i: 'immutable', s: 'stable', v: 'volatile' };
  const relKind: Record<string, TableInfo['kind']> = {
    r: 'table',
    v: 'view',
    m: 'materialized_view',
    p: 'table',
    f: 'table',
  };

  const sampleColumnValues = opts?.sampleColumnValues ?? false;
  const sampleTargets: { schema: string; table: string; column: string; list: ColumnInfo[]; index: number }[] = [];

  const columnsByTable = new Map<string, ColumnInfo[]>();
  for (const r of colRows.rows) {
    const key = `${str(r['schema'])}.${str(r['table'])}`;
    let list = columnsByTable.get(key);
    if (!list) columnsByTable.set(key, (list = []));
    const baseType = str(r['base_type']);
    const enumVals = str(r['typtype']) === 'e' ? enumValuesByType.get(baseType) : undefined;
    const dbType = str(r['type']);
    list.push({
      name: str(r['column']),
      dbType,
      nullable: r['notnull'] !== true,
      default: strOrNull(r['default_expr']),
      generated: r['generated'] === true,
      comment: strOrNull(r['comment']),
      ...(enumVals ? { enumValues: enumVals } : {}),
    });
    // Sample base tables only (r/p): scanning a view or matview runs its defining query.
    const relkind = str(r['relkind']);
    if (
      sampleColumnValues &&
      !enumVals &&
      isSampleablePgType(dbType) &&
      (relkind === 'r' || relkind === 'p') &&
      !SYSTEM_SCHEMAS.includes(str(r['schema']))
    ) {
      sampleTargets.push({
        schema: str(r['schema']),
        table: str(r['table']),
        column: str(r['column']),
        list,
        index: list.length - 1,
      });
    }
  }

  // Opt-in: observe the distinct codes a short non-enum text column holds, on a dedicated
  // client with a SET LOCAL statement_timeout bounding each scan.
  if (sampleTargets.length > 0) {
    const client = db.connect ? await db.connect().catch(() => null) : null;
    const runner: SampleRunner = client ?? db;
    try {
      if (client) {
        await client.query('BEGIN READ ONLY').catch(() => {});
        await client.query(`SET LOCAL statement_timeout = ${SAMPLE_STATEMENT_TIMEOUT_MS}`).catch(() => {});
      }
      let sampleBudget = MAX_SAMPLED_COLUMNS;
      for (const t of sampleTargets) {
        if (sampleBudget <= 0) break;
        sampleBudget--;
        try {
          const sampled = await samplePgColumn(runner, t.schema, t.table, t.column);
          if (sampled) t.list[t.index] = { ...t.list[t.index]!, sampledValues: sampled };
        } catch {
          // Best-effort: a locked-down, huge, or slow column just gets no samples.
        }
      }
    } finally {
      if (client) {
        await client.query('COMMIT').catch(() => {});
        client.release();
      }
    }
  }

  const pkByTable = new Map<string, string[]>();
  const fkByTable = new Map<string, ForeignKeyInfo[]>();
  const uniqByTable = new Map<string, string[][]>();
  const checkByTable = new Map<string, string[]>();
  for (const r of conRows.rows) {
    const key = `${str(r['schema'])}.${str(r['table'])}`;
    const cols = (r['cols'] as string[] | null) ?? [];
    const contype = str(r['contype']);
    if (contype === 'p') pkByTable.set(key, cols);
    else if (contype === 'u') {
      const arr = uniqByTable.get(key) ?? [];
      arr.push(cols);
      uniqByTable.set(key, arr);
    } else if (contype === 'c') {
      const arr = checkByTable.get(key) ?? [];
      arr.push(str(r['def']));
      checkByTable.set(key, arr);
    } else if (contype === 'f') {
      const arr = fkByTable.get(key) ?? [];
      arr.push({
        name: str(r['name']),
        columns: cols,
        refSchema: strOrNull(r['ref_schema']) ?? undefined,
        refTable: str(r['ref_table']),
        refColumns: (r['ref_cols'] as string[] | null) ?? [],
      });
      fkByTable.set(key, arr);
    }
  }

  const idxByTable = new Map<string, IndexInfo[]>();
  for (const r of idxRows.rows) {
    const key = `${str(r['schema'])}.${str(r['table'])}`;
    const def = str(r['def']);
    // The key list runs to the LAST closing bracket, not the first: stopping early turned
    // `(lower(name))` into the fragment `lower(name`, presented as if it were a column.
    const open = def.indexOf('(');
    const close = def.lastIndexOf(')');
    const keyList = open >= 0 && close > open ? def.slice(open + 1, close) : '';
    // An expression index has no column names to list; the definition already carries the detail.
    const cols = keyList.includes('(')
      ? []
      : keyList
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0);
    const arr = idxByTable.get(key) ?? [];
    arr.push({
      name: str(r['name']),
      columns: cols,
      unique: r['unique'] === true,
      method: strOrNull(r['method']) ?? undefined,
      predicate: strOrNull(r['predicate']),
      definition: def,
    });
    idxByTable.set(key, arr);
  }

  const tables: TableInfo[] = relRows.rows.map((r) => {
    const key = `${str(r['schema'])}.${str(r['name'])}`;
    const kind = relKind[str(r['kind'])] ?? 'table';
    return {
      schema: str(r['schema']),
      name: str(r['name']),
      kind,
      columns: columnsByTable.get(key) ?? [],
      primaryKey: pkByTable.get(key) ?? [],
      foreignKeys: fkByTable.get(key) ?? [],
      uniques: uniqByTable.get(key) ?? [],
      checks: checkByTable.get(key) ?? [],
      indexes: idxByTable.get(key) ?? [],
      comment: strOrNull(r['comment']),
      rowEstimate: rowEstimate(r['row_estimate']),
      isPartitioned: r['is_partitioned'] === true,
      partitionOf: strOrNull(r['partition_of']),
      definition: strOrNull(r['definition']),
      source: 'db',
    };
  });

  const triggers: TriggerInfo[] = trgRows.rows.map((r) => {
    const def = str(r['def']);
    const timing = /\bBEFORE\b/i.test(def)
      ? 'BEFORE'
      : /\bAFTER\b/i.test(def)
        ? 'AFTER'
        : /\bINSTEAD OF\b/i.test(def)
          ? 'INSTEAD OF'
          : 'UNKNOWN';
    const events: string[] = [];
    for (const ev of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
      if (new RegExp(`\\b${ev}\\b`, 'i').test(def)) events.push(ev);
    return {
      name: str(r['name']),
      schema: str(r['schema']),
      table: str(r['table']),
      timing,
      events,
      enabled: r['enabled'] === true,
      definition: def,
    };
  });

  const routines: RoutineInfo[] = fnRows.rows.map((r) => ({
    schema: str(r['schema']),
    name: str(r['name']),
    kind: str(r['kind']) === 'p' ? 'procedure' : 'function',
    args: str(r['args']),
    returns: strOrNull(r['returns']),
    language: strOrNull(r['language']),
    volatility: volMap[str(r['volatility'])] ?? 'unknown',
    securityDefiner: r['secdef'] === true,
  }));

  const enums: EnumTypeInfo[] = [...enumsByName.values()].map((e) => ({
    schema: e.schema,
    name: e.name,
    values: e.values,
  }));
  const sequences: SequenceInfo[] = seqRows.rows.map((r) => ({ schema: str(r['schema']), name: str(r['name']) }));
  const extensions = extRows.rows.map((r) => str(r['extname']));

  const hintClient = db.connect ? await db.connect().catch(() => null) : null;
  const hintRunner: SampleRunner = hintClient ?? db;
  let hintedTables = tables;
  try {
    if (hintClient) {
      await hintClient.query('BEGIN READ ONLY').catch(() => {});
      await hintClient.query(`SET LOCAL statement_timeout = ${SAMPLE_STATEMENT_TIMEOUT_MS}`).catch(() => {});
    }
    hintedTables = await withPgColumnHints(hintRunner, tables, sampleColumnValues);
  } catch {
    // Hints are best-effort; a catalog read never fails over them.
  } finally {
    if (hintClient) {
      await hintClient.query('COMMIT').catch(() => {});
      hintClient.release();
    }
  }

  return {
    engine: 'postgres',
    schemas: schemas.length > 0 ? schemas : ['public'],
    tables: hintedTables,
    enums,
    sequences,
    triggers,
    routines,
    extensions,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
