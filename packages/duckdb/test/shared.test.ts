/**
 * Unit tests for the driver-agnostic DuckDB logic in shared.ts - catalog
 * assembly from fixture information_schema rows, type classification, value
 * shaping, file-source validation, and the query timeout race. No DuckDB
 * engine involved.
 */

import { AskSqlError } from '@asksql/core';
import { describe, expect, it } from 'vitest';
import {
  assertSafeFilePath,
  basename,
  buildDuckCatalog,
  buildResultColumns,
  classifyDuckType,
  mapFileError,
  mapQueryError,
  readerFor,
  resolveFormat,
  sanitizeTableName,
  shapeDuckValue,
  uniqueTableName,
  validateSqlDump,
  withQueryTimeout,
} from '../src/shared.js';

/** Run a function expected to throw and hand back the AskSqlError it threw. */
function thrown(fn: () => unknown): AskSqlError {
  try {
    fn();
  } catch (err) {
    return err as AskSqlError;
  }
  throw new Error('expected function to throw');
}

describe('buildDuckCatalog', () => {
  const columnRows = [
    {
      table_schema: 'main',
      table_name: 'orders',
      column_name: 'id',
      data_type: 'BIGINT',
      is_nullable: 'NO',
      column_default: null,
    },
    {
      table_schema: 'main',
      table_name: 'orders',
      column_name: 'note',
      data_type: 'VARCHAR',
      is_nullable: 'YES',
      column_default: "'-'",
    },
    {
      table_schema: 'main',
      table_name: 'recent_orders',
      column_name: 'id',
      data_type: 'BIGINT',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_schema: 'analytics',
      table_name: 'facts',
      column_name: 'k',
      data_type: 'VARCHAR',
      is_nullable: 'YES',
      column_default: null,
    },
  ];

  it('groups columns per table with nullability and defaults', () => {
    const catalog = buildDuckCatalog(columnRows, new Set(), new Set(), []);
    const orders = catalog.tables.find((t) => t.name === 'orders')!;
    expect(orders.columns).toEqual([
      { name: 'id', dbType: 'BIGINT', nullable: false, default: null },
      { name: 'note', dbType: 'VARCHAR', nullable: true, default: "'-'" },
    ]);
  });

  it('marks views, file-registered tables, and non-main schemas', () => {
    const catalog = buildDuckCatalog(columnRows, new Set(['recent_orders']), new Set(['orders']), ['w1']);
    const byName = new Map(catalog.tables.map((t) => [t.name, t]));
    // A registered file is always a table sourced from a file, even if a view backs it.
    expect(byName.get('orders')).toMatchObject({ kind: 'table', source: 'file', schema: undefined });
    expect(byName.get('recent_orders')).toMatchObject({ kind: 'view', source: 'db' });
    expect(byName.get('facts')).toMatchObject({ schema: 'analytics' });
    expect(catalog.schemas.sort()).toEqual(['analytics', 'main']);
    expect(catalog.warnings).toEqual(['w1']);
    expect(catalog.engine).toBe('duckdb');
  });
});

describe('classifyDuckType', () => {
  it('classifies SQL and Arrow type names', () => {
    const cases: [string | undefined, string][] = [
      ['BOOLEAN', 'boolean'],
      ['DECIMAL(18,3)', 'decimal'],
      ['BIGINT', 'bigint'],
      ['Int64', 'bigint'],
      ['HUGEINT', 'bigint'],
      ['TIMESTAMP WITH TIME ZONE', 'timestamp'],
      ['DATE', 'date'],
      ['DOUBLE', 'number'],
      ['INTEGER', 'number'],
      ['Int16', 'number'], // SMALLINT is a 16-bit int, not a bigint
      ['SMALLINT', 'number'],
      ['Int32', 'number'],
      ['VARCHAR', 'text'],
      ['Utf8', 'text'],
      ['BLOB', 'binary'],
      ['JSON', 'json'],
      ['sometype', 'unknown'],
      [undefined, 'unknown'],
    ];
    for (const [input, expected] of cases) expect(classifyDuckType(input), String(input)).toBe(expected);
  });

  it('feeds buildResultColumns', () => {
    expect(buildResultColumns(['a', 'b'], ['BIGINT', undefined])).toEqual([
      { name: 'a', dbType: 'BIGINT', kind: 'bigint' },
      { name: 'b', dbType: undefined, kind: 'unknown' },
    ]);
  });
});

describe('shapeDuckValue', () => {
  it('keeps numeric fidelity and renders binary/temporal/nested values JSON-safely', () => {
    expect(shapeDuckValue(null, 'text')).toBeNull();
    expect(shapeDuckValue(123n, 'bigint')).toBe('123');
    expect(shapeDuckValue(1.5, 'decimal')).toBe('1.5');
    expect(shapeDuckValue(new Date('2020-01-02T03:04:05Z'), 'timestamp')).toBe('2020-01-02T03:04:05.000Z');
    expect(shapeDuckValue(true, 'boolean')).toBe(true);
    expect(shapeDuckValue({ a: 1 }, 'json')).toBe('{"a":1}');
    expect(shapeDuckValue(new Uint8Array([0xde, 0xad]), 'binary')).toEqual({
      __binary: { bytes: 2, hexPreview: 'dead' },
    });
  });
});

describe('table names', () => {
  it('sanitizes filenames into safe identifiers', () => {
    expect(sanitizeTableName('sales report.csv')).toBe('sales_report');
    expect(sanitizeTableName('2024.csv')).toBe('t_2024');
    expect(sanitizeTableName('order.csv')).toBe('order_data'); // reserved word
  });

  it('versions duplicate names', () => {
    expect(uniqueTableName('t', new Set())).toBe('t');
    expect(uniqueTableName('t', new Set(['t', 't_2']))).toBe('t_3');
  });
});

describe('file sources', () => {
  it('resolves format from an explicit hint or the extension', () => {
    expect(resolveFormat({ table: 't', path: 'x.bin', format: 'parquet' })).toBe('parquet');
    expect(resolveFormat({ table: 't', path: 'x.PARQUET' })).toBe('parquet');
    expect(resolveFormat({ table: 't', path: 'x.ndjson' })).toBe('ndjson');
    expect(resolveFormat({ table: 't', path: 'x.xlsx' })).toBe('xlsx');
    expect(resolveFormat({ table: 't', path: 'x.sql' })).toBe('sql');
    expect(resolveFormat({ table: 't', path: 'x.data' })).toBe('csv');
  });

  it('rejects URLs and globs unless explicitly allowed', () => {
    expect(thrown(() => assertSafeFilePath({ table: 't', path: 'https://evil/x.csv' })).code).toBe('CONFIG_ERROR');
    expect(thrown(() => assertSafeFilePath({ table: 't', path: '/data/*.csv' })).code).toBe('CONFIG_ERROR');
    expect(() => assertSafeFilePath({ table: 't', path: 'https://ok/x.csv', allowRemote: true })).not.toThrow();
    expect(() => assertSafeFilePath({ table: 't', path: '/data/*.csv', allowGlob: true })).not.toThrow();
  });

  it('builds the reader expression per format', () => {
    expect(readerFor({ table: 't', path: '/d/x.parquet' }, 'parquet')).toBe("read_parquet('/d/x.parquet')");
    expect(readerFor({ table: 't', path: '/d/x.json' }, 'json')).toBe("read_json_auto('/d/x.json')");
    expect(readerFor({ table: 't', path: '/d/x.xlsx', sheet: 'Q1' }, 'xlsx')).toBe(
      "read_xlsx('/d/x.xlsx', sheet = 'Q1')",
    );
    expect(readerFor({ table: 't', path: "/d/o'brien.csv", encoding: 'latin-1' }, 'csv')).toBe(
      "read_csv_auto('/d/o''brien.csv', encoding='latin-1')",
    );
    expect(thrown(() => readerFor({ table: 't', path: '/d/x.sql' }, 'sql')).code).toBe('FILE_PARSE');
  });
});

describe('validateSqlDump', () => {
  it('accepts a portable CREATE TABLE + INSERT script', () => {
    expect(() => validateSqlDump('CREATE TABLE t(a INT);\nINSERT INTO t VALUES (1);')).not.toThrow();
  });

  it('rejects mysqldump and pg_dump exports with a format-specific message', () => {
    expect(thrown(() => validateSqlDump('CREATE TABLE `t` (a INT) ENGINE=InnoDB;')).userMessage).toMatch(/MySQL/);
    expect(thrown(() => validateSqlDump('COPY t (a) FROM stdin;\n1\n\\.')).userMessage).toMatch(/PostgreSQL/);
  });

  it('rejects statements that reach files, the network, or extensions', () => {
    expect(thrown(() => validateSqlDump("ATTACH 'other.db';")).userMessage).toMatch(/"ATTACH"/);
    expect(
      thrown(() => validateSqlDump("CREATE TABLE t AS SELECT * FROM read_csv('/etc/passwd');")).userMessage,
    ).toMatch(/"READ_CSV"/);
  });

  it('rejects the whole reader/scan family, not just the fixed names (bypass hardening)', () => {
    const bypasses = [
      "CREATE TABLE l AS SELECT * FROM read_csv_auto('/etc/passwd')",
      "CREATE TABLE l AS SELECT * FROM read_json_auto('/etc/passwd')",
      "CREATE TABLE l AS SELECT * FROM read_ndjson_auto('/etc/passwd')",
      "CREATE TABLE l AS SELECT * FROM read_blob('/etc/passwd')",
      "CREATE TABLE l AS SELECT * FROM parquet_scan('/x.parquet')",
      "CREATE TABLE l AS SELECT * FROM sniff_csv('/etc/passwd')",
      "CREATE TABLE l AS SELECT * FROM '/etc/passwd'", // DuckDB bare-path FROM shorthand
      "IMPORT DATABASE '/tmp/db'",
    ];
    for (const sql of bypasses) expect(() => validateSqlDump(sql), sql).toThrow(AskSqlError);
  });
});

describe('withQueryTimeout', () => {
  const pending = new Promise<never>(() => {});

  it('passes through a resolving promise', async () => {
    await expect(withQueryTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it('rejects with DB_TIMEOUT when the deadline passes first', async () => {
    await expect(withQueryTimeout(pending, 10)).rejects.toMatchObject({ code: 'DB_TIMEOUT' });
  });

  it('rejects with CANCELLED on abort', async () => {
    const ctl = new AbortController();
    const p = withQueryTimeout(pending, 5000, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('interrupts the query on timeout so the shared connection is not left running', async () => {
    let interrupted = false;
    await expect(withQueryTimeout(pending, 10, undefined, () => (interrupted = true))).rejects.toMatchObject({
      code: 'DB_TIMEOUT',
    });
    expect(interrupted).toBe(true);
  });

  it('interrupts the query on abort', async () => {
    let interrupted = false;
    const ctl = new AbortController();
    const p = withQueryTimeout(pending, 5000, ctl.signal, () => (interrupted = true));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(interrupted).toBe(true);
  });
});

describe('error shaping', () => {
  it('mapQueryError passes AskSqlError through and wraps driver errors with the first line', () => {
    const passthrough = new AskSqlError('DB_TIMEOUT');
    expect(mapQueryError(passthrough)).toBe(passthrough);
    const mapped = mapQueryError(new Error('Parser Error: syntax error at end of input\nLINE 1: ...'));
    expect(mapped).toMatchObject({
      code: 'DB_QUERY_ERROR',
      userMessage: 'The query failed: Parser Error: syntax error at end of input',
    });
  });

  it('mapFileError names the file in the user message', () => {
    const mapped = mapFileError({ table: 't', path: '/tmp/deep/broken.csv' }, new Error('Invalid Input Error'));
    expect(mapped.code).toBe('FILE_PARSE');
    expect(mapped.userMessage).toContain('"broken.csv"');
  });

  it('basename handles both separators', () => {
    expect(basename('/a/b/c.csv')).toBe('c.csv');
    expect(basename('C:\\data\\c.csv')).toBe('c.csv');
  });
});
