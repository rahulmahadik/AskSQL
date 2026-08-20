/**
 * Oracle schema introspection from the ALL_* data dictionary views, scoped to a single owner
 * (the session's CURRENT_SCHEMA): tables, views, columns, keys, unique constraints, indexes,
 * comments, row estimates, sequences, triggers, and standalone functions/procedures. A view the
 * user cannot read yields a warning, not a throw; enums and sampled values are always empty.
 */

import {
  epochUnitOf,
  HINT_VALUE_CAP,
  isMomentColumn,
  isJsonCandidateColumn,
  jsonArrayElementOf,
  jsonHint,
  jsonShapeOf,
  JSON_SAMPLE_ROWS,
  MAX_HINT_PROBES,
  MAX_HINT_PROBES_PER_TABLE,
} from '@asksql/core';
import type {
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  RoutineInfo,
  SchemaCatalog,
  SequenceInfo,
  TableInfo,
  TriggerInfo,
} from '@asksql/core';

/** Minimal object-mode reader over an oracledb Connection. */
export interface OracleQueryable {
  execute(
    sql: string,
    binds?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ rows?: unknown[] }>;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/**
 * States what an Oracle column's type leaves out: the unit of a NUMBER holding a moment, and the keys
 * inside JSON kept in VARCHAR2/CLOB (or the native JSON type on 21c+). Comparing epoch milliseconds
 * against epoch seconds matches every row and raises no error, and a JSON key the model has to guess at
 * matches none. Structure only - a unit from an aggregate, key names that recur; no cell value is stated.
 */
/** Seconds a single probe may take; without it each of them inherited the whole-introspect bound. */
const HINT_PROBE_TIMEOUT_MS = 2000;

async function withOraColumnHints(
  db: OracleQueryable,
  outFormatObject: number,
  tables: TableInfo[],
  nameKeys: boolean,
): Promise<TableInfo[]> {
  // callTimeout is per round trip, so every probe got a fresh 60s. Bounded here and restored after.
  const conn = db as unknown as { callTimeout?: number };
  const previousTimeout = conn.callTimeout;
  try {
    conn.callTimeout = HINT_PROBE_TIMEOUT_MS;
  } catch {
    // A driver without the knob simply keeps its own bound.
  }
  try {
    const ident = (name: string): string => `"${name.split('"').join('""')}"`;
    let total = MAX_HINT_PROBES;
    const out: TableInfo[] = [];
    for (const table of tables) {
      if (table.kind !== 'table' || total <= 0) {
        out.push(table);
        continue;
      }
      const rel = table.schema ? `${ident(table.schema)}.${ident(table.name)}` : ident(table.name);
      // Per table, so filler tables early in the catalog cannot spend every probe.
      let budget = Math.min(MAX_HINT_PROBES_PER_TABLE, total);
      const columns: ColumnInfo[] = [];
      for (const col of table.columns) {
        const moment = isMomentColumn(col.name, col.dbType);
        const isJson = isJsonCandidateColumn(col.dbType);
        if (budget <= 0 || col.comment || (!moment && !isJson)) {
          columns.push(col); // never overwrite an ALL_COL_COMMENTS entry the DBA wrote
          continue;
        }
        budget--;
        total--;
        try {
          if (moment) {
            const rows = await db.execute(
              `SELECT MIN(${ident(col.name)}) AS LO, MAX(${ident(col.name)}) AS HI FROM ${rel}`,
              {},
              { outFormat: outFormatObject },
            );
            const first = (rows.rows as Record<string, unknown>[] | undefined)?.[0];
            const unit = epochUnitOf(Number(first?.['LO']), Number(first?.['HI']));
            columns.push(unit ? { ...col, comment: unit } : col);
          } else {
            // FETCH FIRST, never LIMIT: Oracle has no LIMIT and would raise ORA-00933.
            const rows = await db.execute(
              `SELECT SUBSTR(TO_CHAR(${ident(col.name)}), 1, ${HINT_VALUE_CAP}) AS V FROM ${rel} WHERE ${ident(col.name)} IS NOT NULL ` +
                `FETCH FIRST ${JSON_SAMPLE_ROWS} ROWS ONLY`,
              {},
              { outFormat: outFormatObject },
            );
            const vals = ((rows.rows as Record<string, unknown>[] | undefined) ?? []).map((r) => r['V']);
            const shape = vals.length > 0 ? jsonShapeOf(vals) : null;
            const el = shape ? null : vals.length > 0 ? jsonArrayElementOf(vals) : null;
            columns.push(
              shape
                ? { ...col, comment: jsonHint(`JSON_VALUE(${ident(col.name)}, '$.key')`, shape.keys, nameKeys) }
                : el
                  ? {
                      ...col,
                      comment:
                        `JSON array of ${el}s; test membership with ` +
                        `JSON_EXISTS(${col.name}, '$?(@ == ${el === 'number' ? '1' : '"a"'})')`,
                    }
                  : col,
            );
          }
        } catch {
          columns.push(col); // best-effort: an unreadable column simply goes undescribed
        }
      }
      out.push({ ...table, columns });
    }
    return out;
  } finally {
    try {
      conn.callTimeout = previousTimeout;
    } catch {
      // best-effort restore
    }
  }
}

export async function introspectOracle(
  db: OracleQueryable,
  outFormatObject: number,
  opts?: { sampleColumnValues?: boolean; schema?: string },
): Promise<SchemaCatalog> {
  const warnings: string[] = [];

  const q = async (label: string, sql: string, binds: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    try {
      const res = await db.execute(sql, binds, { outFormat: outFormatObject });
      // Object outFormat yields one record per row.
      return (res.rows ?? []) as Record<string, unknown>[];
    } catch (err) {
      warnings.push(`Could not read ${label}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };

  // ---- current schema (introspection scope) ----
  // A configured schema wins: tables reached through a grant live under their owner, not the
  // session's, and unquoted Oracle names are stored upper case.
  let owner = (opts?.schema ?? '').trim().toUpperCase();
  if (!owner) {
    const rows = await q('current schema', `SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS SCHEMA FROM DUAL`, {});
    owner = str(rows[0]?.['SCHEMA']);
  }
  if (!owner) {
    // Fall back to the session user; without a scope every ALL_* query spans the whole instance.
    const rows = await q('session user', `SELECT USER AS SCHEMA FROM DUAL`, {});
    owner = str(rows[0]?.['SCHEMA']);
  }

  const binds = { owner };

  // ---- tables + views ----
  const tableRows = await q(
    'tables',
    `SELECT table_name AS name, 'TABLE' AS kind FROM all_tables WHERE owner = :owner
     UNION ALL
     SELECT view_name AS name, 'VIEW' AS kind FROM all_views WHERE owner = :owner`,
    binds,
  );

  // An empty scope is usually a grants-only account, whose tables sit under another owner. Naming
  // the readable schemas turns a silently empty catalog into something the user can act on.
  if (tableRows.length === 0) {
    const others = await q(
      'readable schemas',
      `SELECT owner, COUNT(*) AS n FROM all_tables
       WHERE owner <> :owner AND owner NOT IN ('SYS','SYSTEM','XDB','MDSYS','CTXSYS','OUTLN','DBSNMP','APPQOSSYS','AUDSYS','GSMADMIN_INTERNAL','OJVMSYS','ORDSYS','ORDDATA','OLAPSYS','LBACSYS','WMSYS','DVSYS','RDSADMIN')
       GROUP BY owner ORDER BY COUNT(*) DESC FETCH FIRST 5 ROWS ONLY`,
      binds,
    );
    if (others.length > 0) {
      const names = others.map((r) => `${str(r['OWNER'])} (${str(r['N'])} tables)`).join(', ');
      warnings.push(
        `No tables are visible in ${owner}. Readable schemas: ${names}. Set the connection's schema option to read one of those.`,
      );
    }
  }

  // ---- columns ----
  const colRows = await q(
    'columns',
    `SELECT table_name, column_name, data_type, nullable, data_default
     FROM all_tab_columns WHERE owner = :owner ORDER BY table_name, column_id`,
    binds,
  );

  // ---- primary keys ----
  const pkRows = await q(
    'primary keys',
    `SELECT cc.table_name, cc.column_name, cc.position
     FROM all_constraints c
     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
     WHERE c.owner = :owner AND c.constraint_type = 'P'
     ORDER BY cc.table_name, cc.position`,
    binds,
  );

  // ---- foreign keys ----
  // Each referenced column resolves by matching key position against the referenced constraint.
  const fkRows = await q(
    'foreign keys',
    `SELECT c.constraint_name AS fk_name, cc.table_name, cc.column_name, cc.position,
            rc.owner AS ref_owner, rc.table_name AS ref_table, rcc.column_name AS ref_column
     FROM all_constraints c
     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
     JOIN all_constraints rc ON rc.owner = c.r_owner AND rc.constraint_name = c.r_constraint_name
     JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
                              AND rcc.position = cc.position
     WHERE c.owner = :owner AND c.constraint_type = 'R'
     ORDER BY c.constraint_name, cc.position`,
    binds,
  );

  // ---- table comments ----
  const tabCommentRows = await q(
    'table comments',
    `SELECT table_name, comments FROM all_tab_comments WHERE owner = :owner AND comments IS NOT NULL`,
    binds,
  );

  // ---- column comments ----
  const colCommentRows = await q(
    'column comments',
    `SELECT table_name, column_name, comments FROM all_col_comments WHERE owner = :owner AND comments IS NOT NULL`,
    binds,
  );

  // ---- row estimates ----
  const rowEstRows = await q(
    'row estimates',
    `SELECT table_name, num_rows FROM all_tables WHERE owner = :owner AND num_rows IS NOT NULL`,
    binds,
  );

  // ---- unique constraints ----
  const uniqueRows = await q(
    'unique constraints',
    `SELECT c.constraint_name, cc.table_name, cc.column_name, cc.position
     FROM all_constraints c
     JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
     WHERE c.owner = :owner AND c.constraint_type = 'U'
     ORDER BY cc.table_name, c.constraint_name, cc.position`,
    binds,
  );

  // ---- indexes ----
  const indexRows = await q(
    'indexes',
    `SELECT i.index_name, i.table_name, i.uniqueness, ic.column_name, ic.column_position
     FROM all_indexes i
     JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
     WHERE i.owner = :owner
     ORDER BY i.table_name, i.index_name, ic.column_position`,
    binds,
  );

  // ---- sequences ----
  const seqRows = await q('sequences', `SELECT sequence_name FROM all_sequences WHERE sequence_owner = :owner`, binds);

  // ---- triggers ----
  const triggerRows = await q(
    'triggers',
    `SELECT trigger_name, table_name, trigger_type, triggering_event, status
     FROM all_triggers WHERE owner = :owner`,
    binds,
  );

  // ---- routines (standalone functions + procedures) ----
  const routineRows = await q(
    'routines',
    `SELECT object_name, object_type FROM all_objects
     WHERE owner = :owner AND object_type IN ('FUNCTION', 'PROCEDURE') AND status = 'VALID'`,
    binds,
  );

  const catalog = buildOracleCatalog(
    owner,
    {
      tableRows,
      colRows,
      pkRows,
      fkRows,
      tabCommentRows,
      colCommentRows,
      rowEstRows,
      uniqueRows,
      indexRows,
      seqRows,
      triggerRows,
      routineRows,
    },
    warnings,
  );
  try {
    return {
      ...catalog,
      tables: await withOraColumnHints(db, outFormatObject, [...catalog.tables], opts?.sampleColumnValues === true),
    };
  } catch {
    return catalog; // hints are best-effort; a catalog read never fails over them
  }
}

/** Row sets fetched from the ALL_* dictionary views, as introspectOracle queries them. */
export interface OracleIntrospectRows {
  readonly tableRows: readonly Record<string, unknown>[];
  readonly colRows: readonly Record<string, unknown>[];
  readonly pkRows: readonly Record<string, unknown>[];
  readonly fkRows: readonly Record<string, unknown>[];
  readonly tabCommentRows: readonly Record<string, unknown>[];
  readonly colCommentRows: readonly Record<string, unknown>[];
  readonly rowEstRows: readonly Record<string, unknown>[];
  readonly uniqueRows?: readonly Record<string, unknown>[];
  readonly indexRows?: readonly Record<string, unknown>[];
  readonly seqRows?: readonly Record<string, unknown>[];
  readonly triggerRows?: readonly Record<string, unknown>[];
  readonly routineRows?: readonly Record<string, unknown>[];
}

/** Oracle TRIGGER_TYPE ("BEFORE EACH ROW", "AFTER STATEMENT", "INSTEAD OF") to the catalog timing. */
function triggerTiming(triggerType: string): TriggerInfo['timing'] {
  const t = triggerType.toUpperCase();
  if (t.startsWith('INSTEAD OF')) return 'INSTEAD OF';
  if (t.startsWith('BEFORE')) return 'BEFORE';
  if (t.startsWith('AFTER')) return 'AFTER';
  return 'UNKNOWN';
}

/** Pure assembly of a SchemaCatalog from already-fetched dictionary rows. */
export function buildOracleCatalog(owner: string, rows: OracleIntrospectRows, warnings: string[] = []): SchemaCatalog {
  const { tableRows, colRows, pkRows, fkRows, tabCommentRows, colCommentRows, rowEstRows } = rows;
  const uniqueRows = rows.uniqueRows ?? [];
  const indexRows = rows.indexRows ?? [];
  const seqRows = rows.seqRows ?? [];
  const triggerRows = rows.triggerRows ?? [];
  const routineRows = rows.routineRows ?? [];

  const colCommentByKey = new Map<string, string>();
  for (const r of colCommentRows) {
    colCommentByKey.set(`${str(r['TABLE_NAME'])}.${str(r['COLUMN_NAME'])}`, str(r['COMMENTS']));
  }

  const columnsByTable = new Map<string, ColumnInfo[]>();
  for (const r of colRows) {
    const table = str(r['TABLE_NAME']);
    let list = columnsByTable.get(table);
    if (!list) columnsByTable.set(table, (list = []));
    const name = str(r['COLUMN_NAME']);
    list.push({
      name,
      dbType: str(r['DATA_TYPE']),
      nullable: str(r['NULLABLE']) === 'Y',
      default: strOrNull(r['DATA_DEFAULT']),
      comment: colCommentByKey.get(`${table}.${name}`) ?? null,
    });
  }

  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    const table = str(r['TABLE_NAME']);
    const arr = pkByTable.get(table) ?? [];
    arr.push(str(r['COLUMN_NAME']));
    pkByTable.set(table, arr);
  }

  // Group FK rows (already ordered by name + position) into one entry per constraint.
  const fkByTable = new Map<string, ForeignKeyInfo[]>();
  const fkAcc = new Map<
    string,
    { table: string; name: string; columns: string[]; refSchema?: string; refTable: string; refColumns: string[] }
  >();
  for (const r of fkRows) {
    const fkName = str(r['FK_NAME']);
    const table = str(r['TABLE_NAME']);
    const key = `${table}.${fkName}`;
    let acc = fkAcc.get(key);
    if (!acc) {
      acc = {
        table,
        name: fkName,
        columns: [],
        refSchema: strOrNull(r['REF_OWNER']) ?? undefined,
        refTable: str(r['REF_TABLE']),
        refColumns: [],
      };
      fkAcc.set(key, acc);
    }
    acc.columns.push(str(r['COLUMN_NAME']));
    acc.refColumns.push(str(r['REF_COLUMN']));
  }
  for (const acc of fkAcc.values()) {
    const arr = fkByTable.get(acc.table) ?? [];
    arr.push({
      name: acc.name,
      columns: acc.columns,
      refSchema: acc.refSchema,
      refTable: acc.refTable,
      refColumns: acc.refColumns,
    });
    fkByTable.set(acc.table, arr);
  }

  const commentByTable = new Map<string, string>();
  for (const r of tabCommentRows) commentByTable.set(str(r['TABLE_NAME']), str(r['COMMENTS']));

  const rowEstByTable = new Map<string, number>();
  for (const r of rowEstRows) {
    const n = Number(r['NUM_ROWS']);
    if (Number.isFinite(n)) rowEstByTable.set(str(r['TABLE_NAME']), Math.max(0, n));
  }

  // Unique constraints: one string[] per constraint, grouped under its table.
  const uniqueAcc = new Map<string, string[]>(); // `${table}.${constraint}` -> columns
  const uniqueOrder = new Map<string, string[]>(); // table -> [constraintKey...] first-seen
  for (const r of uniqueRows) {
    const table = str(r['TABLE_NAME']);
    const key = `${table}.${str(r['CONSTRAINT_NAME'])}`;
    if (!uniqueAcc.has(key)) {
      uniqueAcc.set(key, []);
      const list = uniqueOrder.get(table) ?? [];
      list.push(key);
      uniqueOrder.set(table, list);
    }
    uniqueAcc.get(key)!.push(str(r['COLUMN_NAME']));
  }
  const uniquesByTable = new Map<string, string[][]>();
  for (const [table, keys] of uniqueOrder)
    uniquesByTable.set(
      table,
      keys.map((k) => uniqueAcc.get(k)!),
    );

  // Indexes: group columns per index.
  const indexAcc = new Map<string, IndexInfo & { columns: string[] }>();
  const indexOrder = new Map<string, string[]>();
  for (const r of indexRows) {
    const table = str(r['TABLE_NAME']);
    const idxName = str(r['INDEX_NAME']);
    const key = `${table}.${idxName}`;
    if (!indexAcc.has(key)) {
      indexAcc.set(key, { name: idxName, columns: [], unique: str(r['UNIQUENESS']) === 'UNIQUE' });
      const list = indexOrder.get(table) ?? [];
      list.push(key);
      indexOrder.set(table, list);
    }
    indexAcc.get(key)!.columns.push(str(r['COLUMN_NAME']));
  }
  const indexesByTable = new Map<string, IndexInfo[]>();
  for (const [table, keys] of indexOrder)
    indexesByTable.set(
      table,
      keys.map((k) => indexAcc.get(k)!),
    );

  const tables: TableInfo[] = tableRows.map((r) => {
    const name = str(r['NAME']);
    const kind: TableInfo['kind'] = str(r['KIND']) === 'VIEW' ? 'view' : 'table';
    return {
      schema: owner,
      name,
      kind,
      columns: columnsByTable.get(name) ?? [],
      primaryKey: pkByTable.get(name) ?? [],
      foreignKeys: fkByTable.get(name) ?? [],
      uniques: uniquesByTable.get(name) ?? [],
      checks: [],
      indexes: indexesByTable.get(name) ?? [],
      comment: commentByTable.get(name) ?? null,
      rowEstimate: rowEstByTable.get(name) ?? null,
      source: 'db',
    };
  });

  const sequences: SequenceInfo[] = seqRows.map((r) => ({ schema: owner, name: str(r['SEQUENCE_NAME']) }));

  const triggers: TriggerInfo[] = triggerRows.map((r) => ({
    name: str(r['TRIGGER_NAME']),
    schema: owner,
    table: str(r['TABLE_NAME']),
    timing: triggerTiming(str(r['TRIGGER_TYPE'])),
    // "INSERT OR UPDATE OR DELETE" -> ['INSERT','UPDATE','DELETE'].
    events: str(r['TRIGGERING_EVENT'])
      .split(/\s+OR\s+/i)
      .map((e) => e.trim().toUpperCase())
      .filter(Boolean),
    enabled: str(r['STATUS']).toUpperCase() === 'ENABLED',
  }));

  const routines: RoutineInfo[] = routineRows.map((r) => ({
    schema: owner,
    name: str(r['OBJECT_NAME']),
    kind: str(r['OBJECT_TYPE']).toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
    args: '',
    returns: null,
    // The dictionary does not tell us purity, and Oracle functions may be side-effecting.
    volatility: 'unknown',
  }));

  return {
    engine: 'oracle',
    schemas: [owner],
    tables,
    enums: [],
    sequences,
    triggers,
    routines,
    extensions: [],
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
