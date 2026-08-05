/**
 * Row-shaping for the MySQL connector. Columns are classified from the driver's protocol
 * type code, falling back to a value sample only when that code is missing. BIGINT and
 * DECIMAL arrive as strings (bigNumberStrings / decimalNumbers:false) and stay strings;
 * binary becomes a size + hex preview; JSON is re-stringified for the cell.
 */

import { type CellValue, type ResultColumn } from '@asksql/core';

export interface MysqlField {
  name: string;
  columnType?: number;
  type?: number;
}

export function columnsFromFields(fields: readonly MysqlField[], rows: readonly unknown[][]): ResultColumn[] {
  return fields.map((f, i) => {
    // Prefer the driver's column-type code; scan rows for a sample value only when it is missing.
    const kind = mysqlKindFromType(f.columnType ?? f.type) ?? inferMysqlKind(rows.find((r) => r[i] != null)?.[i]);
    return { name: f.name, kind };
  });
}

/** mysql2 protocol column type code -> ColumnKind (the reliable signal). */
function mysqlKindFromType(t: number | undefined): ResultColumn['kind'] | null {
  if (t === undefined) return null;
  switch (t) {
    case 8: // LONGLONG (BIGINT)
      return 'bigint';
    case 0: // DECIMAL
    case 246: // NEWDECIMAL
      return 'decimal';
    case 1: // TINY
    case 2: // SHORT
    case 3: // LONG (INT)
    case 9: // INT24
    case 13: // YEAR
    case 4: // FLOAT
    case 5: // DOUBLE
      return 'number';
    case 7: // TIMESTAMP
    case 12: // DATETIME
      return 'timestamp';
    case 10: // DATE
    case 14: // NEWDATE
      return 'date';
    case 245: // JSON
      return 'json';
    case 249: // TINY_BLOB
    case 250: // MEDIUM_BLOB
    case 251: // LONG_BLOB
    case 252: // BLOB
    case 16: // BIT
      return 'binary';
    case 15: // VARCHAR
    case 253: // VAR_STRING
    case 254: // STRING
    case 247: // ENUM
    case 248: // SET
      return 'text';
    default:
      return null;
  }
}

function inferMysqlKind(sample: unknown): ResultColumn['kind'] {
  if (sample === null || sample === undefined) return 'unknown';
  if (typeof sample === 'bigint') return 'bigint';
  if (typeof sample === 'number') return 'number';
  if (typeof sample === 'boolean') return 'boolean';
  if (Buffer.isBuffer(sample)) return 'binary';
  if (sample instanceof Date) return 'timestamp';
  if (typeof sample === 'object') return 'json';
  // Strings that look like a big integer or decimal (from bigNumberStrings).
  if (typeof sample === 'string' && /^-?\d{16,}$/.test(sample)) return 'bigint';
  if (typeof sample === 'string' && /^-?\d+\.\d+$/.test(sample)) return 'decimal';
  return 'text';
}

export function shapeMysqlValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return { __binary: { bytes: v.length, hexPreview: v.subarray(0, 16).toString('hex') } };
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}
