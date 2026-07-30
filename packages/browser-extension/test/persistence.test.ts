import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  databaseFileName,
  databasePath,
  removeAllPersistedDatabases,
  removePersistedDatabase,
} from '../src/persistence.js';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';

describe('persistence', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  it('gives each connection its own opfs:// database path', () => {
    expect(databasePath('abc')).toBe('opfs://asksql-conn-abc.db');
    expect(databasePath('xyz')).not.toBe(databasePath('abc'));
  });

  it('removePersistedDatabase drops that connection and its sidecar files, leaving others alone', async () => {
    mock.opfsFiles.add(databaseFileName('abc'));
    mock.opfsFiles.add(`${databaseFileName('abc')}.wal`);
    mock.opfsFiles.add(databaseFileName('xyz'));
    mock.opfsFiles.add('unrelated-file.txt');

    await removePersistedDatabase('abc');

    expect(mock.opfsFiles.has(databaseFileName('abc'))).toBe(false);
    expect(mock.opfsFiles.has(`${databaseFileName('abc')}.wal`)).toBe(false);
    expect(mock.opfsFiles.has(databaseFileName('xyz'))).toBe(true);
    expect(mock.opfsFiles.has('unrelated-file.txt')).toBe(true);
  });

  it('removeAllPersistedDatabases drops every AskSQL database but nothing else', async () => {
    mock.opfsFiles.add(databaseFileName('abc'));
    mock.opfsFiles.add(databaseFileName('xyz'));
    mock.opfsFiles.add('unrelated-file.txt');

    await removeAllPersistedDatabases();

    expect(mock.opfsFiles.has(databaseFileName('abc'))).toBe(false);
    expect(mock.opfsFiles.has(databaseFileName('xyz'))).toBe(false);
    expect(mock.opfsFiles.has('unrelated-file.txt')).toBe(true);
  });

  it('is a no-op when nothing was persisted', async () => {
    await expect(removePersistedDatabase('missing')).resolves.toBeUndefined();
    await expect(removeAllPersistedDatabases()).resolves.toBeUndefined();
  });

  it('tolerates a single entry failing to delete rather than rejecting the whole removal, and logs it', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          getDirectory: async () => ({
            async *keys() {
              yield databaseFileName('abc');
            },
            async removeEntry() {
              throw new Error('locked by another process');
            },
          }),
        },
      },
      configurable: true,
      writable: true,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(removePersistedDatabase('abc')).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(databaseFileName('abc')), expect.any(Error));
  });
});
