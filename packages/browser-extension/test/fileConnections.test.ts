// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DuckDB-WASM needs a real browser, so the connector is faked and the SQL it
 * would run is recorded. What is under test is the orchestration around it:
 * which files become which tables, the .sql-dump special case, zip expansion,
 * and cleanup when a load fails.
 */
const { instances, FakeConnector } = vi.hoisted(() => {
  const created: FakeConnectorShape[] = [];

  class Fake {
    readonly executed: string[] = [];
    readonly registered: { table: string; filename: string; sheet?: string }[] = [];
    closed = false;
    tables: string[] = [];
    failOnExecuteMatching: RegExp | null = null;
    throwNonError = false;

    constructor(readonly opts: { id: string; name: string; persistPath: string }) {
      created.push(this as unknown as FakeConnectorShape);
    }

    async connect(): Promise<void> {}
    async close(): Promise<void> {
      this.closed = true;
    }

    async registerFile({
      table,
      filename,
      sheet,
    }: {
      table: string;
      filename: string;
      sheet?: string;
    }): Promise<string> {
      this.registered.push({ table, filename, sheet });
      // A .sql dump creates its own tables; anything else becomes a scratch view.
      if (/\.sql$/i.test(filename)) this.tables.push('from_dump');
      return table;
    }

    async execute(sql: string): Promise<void> {
      if (this.failOnExecuteMatching?.test(sql)) {
        if (this.throwNonError) throw 'duckdb exploded';
        throw new Error('load failed');
      }
      this.executed.push(sql);
      const createdTable = /CREATE OR REPLACE TABLE "([^"]+)"/.exec(sql);
      if (createdTable?.[1]) this.tables.push(createdTable[1]);
    }

    async introspect(): Promise<{ tables: { name: string }[] }> {
      return { tables: this.tables.map((name) => ({ name })) };
    }
  }

  return { instances: created, FakeConnector: Fake };
});

interface FakeConnectorShape {
  readonly executed: string[];
  readonly registered: { table: string; filename: string; sheet?: string }[];
  closed: boolean;
  tables: string[];
  failOnExecuteMatching: RegExp | null;
  throwNonError: boolean;
  readonly opts: { id: string; name: string; persistPath: string };
}

vi.mock('@asksql/duckdb/browser', () => ({
  DuckDbWasmConnector: FakeConnector,
  quoteIdent: (s: string) => `"${s.replace(/"/g, '""')}"`,
  sanitizeTableName: (s: string) => s.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_'),
}));

vi.mock('../src/duckdbBundles.js', () => ({ BUNDLES: {}, XLSX_EXTENSION_REPOSITORY: 'chrome-extension://test/ext' }));

import {
  createFileConnection,
  deleteFileConnection,
  renameFileConnection,
  expandUploads,
  getFileConnections,
  openFileConnector,
} from '../src/fileConnections.js';
import { databaseFileName } from '../src/persistence.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';
import { buildTestZip } from './zipFixture.js';

const csv = (name = 'sales.csv') => new File(['a,b\n1,2\n'], name);

describe('fileConnections', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    instances.length = 0;
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  it('creates a connection whose tables come from the loaded files, and persists it', async () => {
    const { connection, connections } = await createFileConnection('Q1 sales', [csv()]);

    expect(connection.name).toBe('Q1 sales');
    expect(connection.tables).toEqual(['sales']);
    expect(connections).toHaveLength(1);
    expect(await getFileConnections()).toEqual([connection]);
  });

  it('gives each connection its own database file, so two never collide', async () => {
    const a = await createFileConnection('First', [csv()]);
    const b = await createFileConnection('Second', [csv()]);

    expect(a.connection.id).not.toBe(b.connection.id);
    const paths = instances.map((i) => i.opts.persistPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('closes the database after building it, so the side panel can open it', async () => {
    await createFileConnection('Q1', [csv()]);
    expect(instances.every((i) => i.closed)).toBe(true);
  });

  it('materializes a normal file into a real table rather than leaving a view behind', async () => {
    await createFileConnection('Q1', [csv()]);
    const sql = instances[0]!.executed.join('\n');
    expect(sql).toContain('CREATE OR REPLACE TABLE "sales"');
    expect(sql).toContain('DROP VIEW');
  });

  it('runs a .sql dump directly and never tries to drop a view it did not create', async () => {
    await createFileConnection('Dump', [new File(['CREATE TABLE t(x INT);'], 'regions.sql')]);
    expect(instances[0]!.executed.join('\n')).not.toContain('DROP VIEW');
  });

  it('creates one table per sheet for a multi-sheet workbook', async () => {
    const workbook = `<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheets><sheet name="Products" sheetId="1"/><sheet name="Orders" sheetId="2"/></sheets>
</workbook>`;
    const zip = buildTestZip([{ name: 'xl/workbook.xml', content: workbook }]);
    const { connection } = await createFileConnection('Book', [new File([zip], 'book.xlsx')]);

    expect(connection.tables).toEqual(['book_Products', 'book_Orders']);
    expect(instances[0]!.registered.map((r) => r.sheet)).toEqual(['Products', 'Orders']);
  });

  it('explains what to do when a build cannot enable .xlsx support, instead of surfacing a raw DuckDB error', async () => {
    const zip = buildTestZip([{ name: 'xl/workbook.xml', content: '<workbook/>' }]);
    const create = createFileConnection('Book', [new File([zip], 'book.xlsx')]);
    await Promise.resolve();
    const connector = instances[0];
    if (connector) connector.failOnExecuteMatching = /custom_extension_repository/;

    await expect(create).rejects.toThrow(/Use CSV, JSON, Parquet, or a \.sql dump instead/);
  });

  it('still explains itself when the underlying failure is not an Error object', async () => {
    const zip = buildTestZip([{ name: 'xl/workbook.xml', content: '<workbook/>' }]);
    const create = createFileConnection('Book', [new File([zip], 'book.xlsx')]);
    await Promise.resolve();
    const connector = instances[0];
    if (connector) {
      connector.throwNonError = true;
      connector.failOnExecuteMatching = /custom_extension_repository/;
    }

    await expect(create).rejects.toThrow(/duckdb exploded/);
  });

  it('reports the original load failure even if cleaning up the half-built database also fails', async () => {
    const create = createFileConnection('Broken', [csv()]);
    await Promise.resolve();
    const connector = instances[0];
    if (connector) connector.failOnExecuteMatching = /CREATE OR REPLACE TABLE/;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          getDirectory: async () => {
            throw new Error('OPFS unavailable');
          },
        },
      },
      configurable: true,
      writable: true,
    });

    await expect(create).rejects.toThrow('load failed');
  });

  it('expands a zip into its data files and reports what it left out', async () => {
    const zip = buildTestZip([
      { name: 'customers.csv', content: 'a,b\n1,2\n' },
      { name: 'README.md', content: '# notes' },
    ]);
    const { files, skipped } = await expandUploads([new File([zip], 'bundle.zip')]);

    expect(files.map((f) => f.name)).toEqual(['customers.csv']);
    expect(skipped).toEqual(['README.md']);
  });

  it('surfaces zip contents as tables and reports the skipped member when creating a connection', async () => {
    const zip = buildTestZip([
      { name: 'customers.csv', content: 'a,b\n1,2\n' },
      { name: 'README.md', content: '# notes' },
    ]);
    const { connection, skipped } = await createFileConnection('Bundle', [new File([zip], 'bundle.zip')]);

    expect(connection.tables).toEqual(['customers']);
    expect(skipped).toEqual(['README.md']);
  });

  it('keeps both files whose names sanitize to the same table, and says what it renamed', async () => {
    const zip = buildTestZip([
      { name: '2024/sales.csv', content: 'a,b\n1,2\n' },
      { name: '2025/sales.csv', content: 'a,b\n3,4\n' },
    ]);
    const { connection, renamed } = await createFileConnection('Bundle', [new File([zip], 'bundle.zip')]);

    expect(connection.tables).toEqual(['sales', 'sales_2']);
    expect(renamed).toEqual(['sales -> sales_2']);
  });

  it('leaves non-colliding uploads alone', async () => {
    const { renamed } = await createFileConnection('Q1', [csv('sales.csv'), csv('regions.csv')]);
    expect(renamed).toEqual([]);
  });

  it('does not let a later file replace a table a .sql dump created', async () => {
    const dump = new File(['CREATE TABLE from_dump(x INT);'], 'dump.sql');
    const { connection } = await createFileConnection('Mixed', [dump, csv('from_dump.csv')]);
    expect(connection.tables).toEqual(['from_dump', 'from_dump_2']);
  });

  it('refuses an unnamed connection', async () => {
    await expect(createFileConnection('   ', [csv()])).rejects.toThrow('name');
  });

  it('refuses a selection with no usable data file, rather than creating an empty connection', async () => {
    const zip = buildTestZip([{ name: 'README.md', content: '# notes' }]);
    await expect(createFileConnection('Empty', [new File([zip], 'bundle.zip')])).rejects.toThrow(
      'No usable data files',
    );
    expect(await getFileConnections()).toEqual([]);
  });

  it('deletes the half-built database and saves nothing when loading fails partway', async () => {
    const failing = new File(['x'], 'broken.csv');
    mock.opfsFiles.add(databaseFileName('will-not-match'));
    const create = createFileConnection('Broken', [failing]);
    // The connector is constructed synchronously inside createFileConnection,
    // so arm the failure as soon as it exists.
    await Promise.resolve();
    const connector = instances[0];
    if (connector) connector.failOnExecuteMatching = /CREATE OR REPLACE TABLE/;

    await expect(create).rejects.toThrow('load failed');
    expect(await getFileConnections()).toEqual([]);
    expect(instances[0]!.closed).toBe(true);
  });

  it('openFileConnector connects to that connection database', async () => {
    const { connection } = await createFileConnection('Q1', [csv()]);
    instances.length = 0;

    const connector = await openFileConnector(connection);

    expect(instances).toHaveLength(1);
    expect(instances[0]!.opts.persistPath).toContain(connection.id);
    expect(connector).toBe(instances[0]);
  });

  it('deleting a connection removes both its metadata and its stored data', async () => {
    const { connection } = await createFileConnection('Q1', [csv()]);
    mock.opfsFiles.add(databaseFileName(connection.id));

    const remaining = await deleteFileConnection(connection.id);

    expect(remaining).toEqual([]);
    expect(await getFileConnections()).toEqual([]);
    expect(mock.opfsFiles.has(databaseFileName(connection.id))).toBe(false);
  });

  it('deleting one connection leaves the others intact', async () => {
    const a = await createFileConnection('A', [csv()]);
    const b = await createFileConnection('B', [csv()]);

    const remaining = await deleteFileConnection(a.connection.id);

    expect(remaining.map((c) => c.name)).toEqual(['B']);
    expect(remaining[0]!.id).toBe(b.connection.id);
  });

  it('renames a connection without touching its tables or stored data', async () => {
    const { connection } = await createFileConnection('Old name', [csv()]);
    mock.opfsFiles.add(databaseFileName(connection.id));

    const next = await renameFileConnection(connection.id, '  New name  ');

    expect(next[0]!.name).toBe('New name');
    expect(next[0]!.id).toBe(connection.id);
    expect(next[0]!.tables).toEqual(connection.tables);
    expect(mock.opfsFiles.has(databaseFileName(connection.id))).toBe(true);
  });

  it('refuses to rename a connection to nothing', async () => {
    const { connection } = await createFileConnection('Keep', [csv()]);
    await expect(renameFileConnection(connection.id, '   ')).rejects.toThrow('name');
    expect((await getFileConnections())[0]!.name).toBe('Keep');
  });

  it('renames only the targeted connection', async () => {
    const a = await createFileConnection('A', [csv()]);
    await createFileConnection('B', [csv()]);

    const next = await renameFileConnection(a.connection.id, 'A2');

    expect(next.map((c) => c.name).sort()).toEqual(['A2', 'B']);
  });
});
