/**
 * Map a raw database type name to a coarse {@link ColumnKind} used for
 * result rendering and the numeric-fidelity rule. Connectors call
 * this so classification stays consistent across engines.
 */

import type { ColumnKind } from './types.js';

export function classifyColumnKind(dbType: string | null | undefined): ColumnKind {
  if (!dbType) return 'unknown';
  const t = dbType.toLowerCase();

  if (/(^|\b)(bool|boolean|bit|tinyint\(1\))\b/.test(t)) return 'boolean';
  if (/\b(bigint|int8|bigserial)\b/.test(t)) return 'bigint';
  if (/\b(numeric|decimal|money|number)\b/.test(t)) return 'decimal';
  if (/\b(smallint|integer|int|int2|int4|serial|mediumint|year)\b/.test(t)) return 'number';
  if (/\b(real|double|float|float4|float8)\b/.test(t)) {
    // DOUBLE PRECISION / FLOAT fit in JS number safely enough for display.
    return 'number';
  }
  if (/\b(timestamp|timestamptz|datetime)\b/.test(t)) return 'timestamp';
  if (/\bdate\b/.test(t)) return 'date';
  if (/\b(json|jsonb)\b/.test(t)) return 'json';
  if (/\b(bytea|blob|binary|varbinary|image)\b/.test(t)) return 'binary';
  if (/\b(text|char|varchar|character|clob|string|uuid|enum|name|citext|inet|cidr|xml)\b/.test(t)) {
    return 'text';
  }
  return 'unknown';
}

