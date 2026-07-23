/**
 * Row-shaping shared by the Postgres connector. Applies the numeric
 * fidelity rule: BIGINT / NUMERIC arrive from `pg` as strings and
 * must stay strings; binary (bytea) becomes a size + hex preview; JSON is
 * kept as parsed values and re-stringified for the cell.
 */

import { classifyColumnKind, type CellValue, type ColumnKind, type ResultColumn } from '@asksql/core';

const HEX_PREVIEW_BYTES = 16;

export function bufferToCell(buf: Buffer): CellValue {
  const preview = buf.subarray(0, HEX_PREVIEW_BYTES).toString('hex');
  return { __binary: { bytes: buf.length, hexPreview: preview } };
}

export function shapeValue(value: unknown, kind: ColumnKind): CellValue {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return bufferToCell(value);
  if (value instanceof Date) return value.toISOString();
  switch (kind) {
    case 'bigint':
    case 'decimal':
      // pg returns these as strings already; never coerce to number.
      return typeof value === 'string' ? value : String(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'boolean':
      return typeof value === 'boolean' ? value : value === 't' || value === 'true' || value === true;
    case 'number': {
      if (typeof value === 'number') return value;
      const n = Number(value);
      return Number.isFinite(n) ? n : String(value);
    }
    default: {
      if (typeof value === 'object') return JSON.stringify(value);
      return typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    }
  }
}

/** Postgres numeric type OIDs -> keep as string for fidelity. */
const OID_KIND: Record<number, ColumnKind> = {
  20: 'bigint', // int8
  1700: 'decimal', // numeric
  16: 'boolean', // bool
  114: 'json',
  3802: 'json', // jsonb
  17: 'binary', // bytea
  1114: 'timestamp',
  1184: 'timestamp', // timestamptz
  1082: 'date',
  21: 'number',
  23: 'number',
  700: 'number',
  701: 'number',
};

export interface PgField {
  name: string;
  dataTypeID: number;
}

export function columnsFromFields(fields: readonly PgField[], typeName: (oid: number) => string): ResultColumn[] {
  return fields.map((f) => {
    const dbType = typeName(f.dataTypeID);
    const kind = OID_KIND[f.dataTypeID] ?? classifyColumnKind(dbType);
    return { name: f.name, dbType, kind };
  });
}
