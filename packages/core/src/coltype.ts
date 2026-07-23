/**
 * Map a raw database type name to a coarse {@link ColumnKind} used for result
 * rendering and the numeric-fidelity rule. The shared fallback across engines;
 * connectors with their own type map (Oracle, DuckDB, Postgres OIDs) call this
 * for anything their map does not cover. Unrecognized types return 'unknown'
 * and render as text, so a novel type never breaks a result.
 */

import type { ColumnKind } from './types.js';

export function classifyColumnKind(dbType: string | null | undefined): ColumnKind {
  if (!dbType) return 'unknown';
  const t = dbType.toLowerCase();

  // Boolean before the numeric families: MySQL BOOLEAN is tinyint(1) (no trailing
  // word boundary, so matched directly); a bit string (bit varying / bit(n>1)) is not a boolean.
  if (
    /\btinyint\(1\)/.test(t) ||
    /(^|\b)(bool|boolean)\b/.test(t) ||
    /(^|\b)bit\b(?!\s*varying)(?!\s*\(\s*(?!1\s*\)))/.test(t)
  )
    return 'boolean';

  // Exact-numeric first (fidelity: these travel as strings, never JS number).
  if (/\b(bigint|int8|bigserial)\b/.test(t)) return 'bigint';
  if (/\b(numeric|decimal|money|dec|number)\b/.test(t)) return 'decimal';

  // Integer / floating families -> number.
  if (/\b(smallint|integer|int|int2|int4|serial|smallserial|mediumint|tinyint|year)\b/.test(t)) return 'number';
  if (/\b(real|double|float|float4|float8|binary_float|binary_double)\b/.test(t)) return 'number';

  // Temporal. datetime is caught by timestamp; a bare time-of-day has no dedicated kind.
  if (/\b(timestamp|timestamptz|datetime)\b/.test(t)) return 'timestamp';
  if (/\bdate\b/.test(t)) return 'date';

  if (/\bjson/.test(t)) return 'json'; // json, jsonb
  // bytea/blob (+ long/medium/tiny), binary/varbinary, Oracle RAW/LONG RAW/BFILE.
  if (/\b(bytea|binary|varbinary|image|raw|bfile)\b|\b(long|medium|tiny)?blob\b/.test(t)) return 'binary';

  // Text families, including the compound names other classifiers miss
  // (longtext/mediumtext/tinytext, varchar2/nvarchar2, nchar).
  if (
    /(^|\b)(long|medium|tiny)text\b|\bn?text\b|\bn?(var)?char\d*\b|\bcharacter\b|\bstring\b|\bn?clob\b|\benum\b|\bset\b|\bname\b|\bcitext\b|\b(uuid|inet|cidr|macaddr|xml)\b/.test(
      t,
    )
  ) {
    return 'text';
  }
  return 'unknown';
}
