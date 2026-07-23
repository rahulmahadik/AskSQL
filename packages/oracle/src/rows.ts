/**
 * Row-shaping shared by the Oracle connector. Applies the numeric
 * fidelity rule: NUMBER is fetched from `oracledb` as a string and must
 * stay a string for DECIMAL / BIGINT columns; BLOB / RAW become a size +
 * hex preview; DATE / TIMESTAMP arrive as JS Dates and are rendered as ISO.
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
      // NUMBER is fetched as a string (see fetchAsString in index.ts); never
      // coerce to a JS number and risk losing precision.
      return typeof value === 'string' ? value : String(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'boolean':
      // Oracle has no native boolean; a 1/0 or 'Y'/'N' surrogate may arrive here.
      return typeof value === 'boolean' ? value : value === 1 || value === '1' || value === 'Y' || value === 'true';
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

/**
 * Oracle data-type names -> ColumnKind. Covers the numeric-fidelity and
 * binary/temporal cases where the shared regex classifier would be ambiguous
 * (e.g. RAW, TIMESTAMP WITH TIME ZONE). Everything else falls through to
 * {@link classifyColumnKind}.
 */
const ORACLE_TYPE_KIND: Record<string, ColumnKind> = {
  NUMBER: 'decimal',
  FLOAT: 'number',
  BINARY_FLOAT: 'number',
  BINARY_DOUBLE: 'number',
  DATE: 'timestamp', // Oracle DATE carries a time component
  TIMESTAMP: 'timestamp',
  'TIMESTAMP WITH TIME ZONE': 'timestamp',
  'TIMESTAMP WITH LOCAL TIME ZONE': 'timestamp',
  RAW: 'binary',
  'LONG RAW': 'binary',
  BLOB: 'binary',
  BFILE: 'binary',
  CLOB: 'text',
  NCLOB: 'text',
  VARCHAR2: 'text',
  NVARCHAR2: 'text',
  CHAR: 'text',
  NCHAR: 'text',
  LONG: 'text',
  ROWID: 'text',
  UROWID: 'text',
  JSON: 'json',
};

export interface OracleField {
  readonly name: string;
  /** oracledb metaData.dbTypeName, e.g. "VARCHAR2", "NUMBER", "TIMESTAMP(6)". */
  readonly dbTypeName?: string;
}

function kindForOracleType(dbType: string): ColumnKind {
  const upper = dbType.toUpperCase();
  // Exact match first, then a prefix match so "TIMESTAMP(6)" / "TIMESTAMP(6) WITH
  // TIME ZONE" resolve, then the shared classifier.
  if (ORACLE_TYPE_KIND[upper]) return ORACLE_TYPE_KIND[upper]!;
  for (const key of Object.keys(ORACLE_TYPE_KIND)) {
    if (upper.startsWith(key)) return ORACLE_TYPE_KIND[key]!;
  }
  return classifyColumnKind(dbType);
}

export function columnsFromMeta(meta: readonly OracleField[]): ResultColumn[] {
  return meta.map((f) => {
    const dbType = f.dbTypeName ?? 'unknown';
    return { name: f.name, dbType, kind: kindForOracleType(dbType) };
  });
}
