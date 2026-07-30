/** A "data files" connection: uploaded files loaded into their own OPFS-backed DuckDB database, picked like any other connection. Files are materialized into real tables, not views over File handles - a view cannot outlive the page that registered it, and a connection must survive a reload. */
import { DuckDbWasmConnector, quoteIdent, sanitizeTableName } from '@asksql/duckdb/browser';
import { BUNDLES, XLSX_EXTENSION_REPOSITORY } from './duckdbBundles.js';
import { databasePath, removePersistedDatabase } from './persistence.js';
import { listXlsxSheets } from './xlsxSheets.js';
import { expandZipFile, isZipFile } from './zipUpload.js';

export interface FileConnection {
  readonly id: string;
  readonly name: string;
  /** Table names the upload produced, so Settings can show what is in the connection without opening it. */
  readonly tables: readonly string[];
}

const KEY = 'asksql.fileConnections';

export const ACCEPTED_UPLOAD_EXTENSIONS = '.csv,.tsv,.json,.ndjson,.parquet,.xlsx,.sql,.zip';

function isXlsxFile(file: File): boolean {
  return /\.xlsx$/i.test(file.name);
}

function isSqlDumpFile(file: File): boolean {
  return /\.sql$/i.test(file.name);
}

export async function getFileConnections(): Promise<FileConnection[]> {
  const got = await chrome.storage.local.get([KEY]);
  return (got[KEY] as FileConnection[] | undefined) ?? [];
}

async function setFileConnections(connections: readonly FileConnection[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: connections });
}

/** Connects to an existing connection's database. The caller owns closing it. */
export async function openFileConnector(connection: FileConnection): Promise<DuckDbWasmConnector> {
  const connector = new DuckDbWasmConnector({
    id: connection.id,
    name: connection.name,
    bundles: BUNDLES,
    persistPath: databasePath(connection.id),
  });
  await connector.connect();
  return connector;
}

/**
 * A `.sql` dump is executed by registerFile() and creates whatever tables its
 * own CREATE TABLE statements name, so it is already durable and must not go
 * through the materialize-then-drop-view path (the "view" is a real table).
 */
async function registerAndMaterialize(
  connector: DuckDbWasmConnector,
  table: string,
  file: File,
  sheet?: string,
): Promise<void> {
  if (isSqlDumpFile(file)) {
    await connector.registerFile({ table, data: file, filename: file.name });
    return;
  }
  const scratch = await connector.registerFile({ table: `${table}__upload`, data: file, filename: file.name, sheet });
  await connector.execute(`CREATE OR REPLACE TABLE ${quoteIdent(table)} AS SELECT * FROM ${quoteIdent(scratch)}`);
  await connector.execute(`DROP VIEW ${quoteIdent(scratch)}`);
}

async function loadFiles(
  connector: DuckDbWasmConnector,
  files: readonly File[],
  onStatus: (s: string) => void,
): Promise<void> {
  if (files.some(isXlsxFile)) {
    try {
      await connector.execute(`SET custom_extension_repository = '${XLSX_EXTENSION_REPOSITORY}';`);
    } catch (err) {
      throw new Error(
        `Could not enable .xlsx support in this build (${err instanceof Error ? err.message : String(err)}). Use CSV, JSON, Parquet, or a .sql dump instead.`,
      );
    }
  }
  for (const file of files) {
    onStatus(`Loading ${file.name}...`);
    const baseTable = sanitizeTableName(file.name);
    const sheets = isXlsxFile(file) ? await listXlsxSheets(file) : [];
    if (sheets.length <= 1) {
      await registerAndMaterialize(connector, baseTable, file);
      continue;
    }
    for (const sheet of sheets) {
      await registerAndMaterialize(connector, sanitizeTableName(`${baseTable}_${sheet}`), file, sheet);
    }
  }
}

/** Expands any .zip in the selection into the data files it holds, reporting what was left out. */
export async function expandUploads(selected: readonly File[]): Promise<{ files: File[]; skipped: string[] }> {
  const files: File[] = [];
  const skipped: string[] = [];
  for (const file of selected) {
    if (!isZipFile(file)) {
      files.push(file);
      continue;
    }
    const expanded = await expandZipFile(file);
    files.push(...expanded.files);
    skipped.push(...expanded.skipped);
  }
  return { files, skipped };
}

export interface CreatedFileConnection {
  readonly connection: FileConnection;
  readonly connections: FileConnection[];
  readonly skipped: readonly string[];
}

/**
 * Builds a new connection from the selected files. The database is left on
 * disk and closed - the side panel opens it later, exactly as it would a
 * connection created in an earlier browser session.
 */
export async function createFileConnection(
  name: string,
  selected: readonly File[],
  onStatus: (s: string) => void = () => {},
): Promise<CreatedFileConnection> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Give this connection a name.');

  onStatus('Reading files...');
  const { files, skipped } = await expandUploads(selected);
  if (files.length === 0) {
    throw new Error('No usable data files were found. Supported: CSV, TSV, JSON, NDJSON, Parquet, Excel, .sql dumps.');
  }

  const id = `file_${Math.random().toString(36).slice(2, 10)}`;
  const connector = new DuckDbWasmConnector({ id, name: trimmed, bundles: BUNDLES, persistPath: databasePath(id) });
  await connector.connect();
  try {
    await loadFiles(connector, files, onStatus);
    const catalog = await connector.introspect();
    const connection: FileConnection = { id, name: trimmed, tables: catalog.tables.map((t) => t.name) };
    const connections = [...(await getFileConnections()), connection];
    await setFileConnections(connections);
    return { connection, connections, skipped };
  } catch (err) {
    // Never leave a half-built database behind that no connection points at.
    await removePersistedDatabase(id).catch(() => {});
    throw err;
  } finally {
    await connector.close();
  }
}

/** Only the display name is editable: the tables and their data are fixed at upload. */
export async function renameFileConnection(id: string, name: string): Promise<FileConnection[]> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Give this connection a name.');
  const next = (await getFileConnections()).map((c) => (c.id === id ? { ...c, name: trimmed } : c));
  await setFileConnections(next);
  return next;
}

export async function deleteFileConnection(id: string): Promise<FileConnection[]> {
  const next = (await getFileConnections()).filter((c) => c.id !== id);
  await setFileConnections(next);
  await removePersistedDatabase(id);
  return next;
}
