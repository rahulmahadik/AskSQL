/** One OPFS-backed DuckDB database per data-file connection, persisted because Edge reloads the side-panel document on tab switch (microsoft/MicrosoftEdge-Extensions#222) and a connection must outlive the panel. No TTL: data is erased only by removing the connection or Reset everything. */
const FILE_PREFIX = 'asksql-conn-';

export function databaseFileName(connectionId: string): string {
  return `${FILE_PREFIX}${connectionId}.db`;
}

export function databasePath(connectionId: string): string {
  return `opfs://${databaseFileName(connectionId)}`;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/** Every OPFS entry whose name starts with `prefix`, including DuckDB's sidecar files (e.g. a .wal). */
async function entriesWithPrefix(prefix: string): Promise<string[]> {
  const root = await opfsRoot();
  const names: string[] = [];
  // @ts-expect-error -- FileSystemDirectoryHandle is async-iterable at runtime; lib.dom's types haven't caught up.
  for await (const name of root.keys()) {
    if (typeof name === 'string' && name.startsWith(prefix)) names.push(name);
  }
  return names;
}

async function removeEntries(names: readonly string[]): Promise<void> {
  const root = await opfsRoot();
  await Promise.all(
    names.map((name) =>
      root.removeEntry(name).catch((err: unknown) => {
        console.error(`AskSQL: could not remove persisted database file "${name}"`, err);
      }),
    ),
  );
}

/** Drops one connection's database and any sidecar files DuckDB wrote alongside it. */
export async function removePersistedDatabase(connectionId: string): Promise<void> {
  await removeEntries(await entriesWithPrefix(databaseFileName(connectionId)));
}

/** Drops every AskSQL database, for Reset. */
export async function removeAllPersistedDatabases(): Promise<void> {
  await removeEntries(await entriesWithPrefix(FILE_PREFIX));
}
