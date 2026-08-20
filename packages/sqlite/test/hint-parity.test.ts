/**
 * The TypeScript half of the derived-hint specification in packages/jetbrains/tools/parity/vectors/hints.json. The Kotlin
 * half is HintParityTest.kt, and both assert the SAME expectations, so a change on one side fails on
 * that side instead of quietly becoming the new truth.
 *
 * This exists because the two implementations had already drifted once: the hand-rolled Kotlin JSON
 * parser accepted `{not json` as a valid empty object where JSON.parse throws, so the same column was
 * called JSON in Android Studio and not in VS Code.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SqliteConnector } from '../src/index.js';

interface Vector {
  readonly name: string;
  readonly column: string;
  readonly dbType: string;
  readonly rows: readonly (string | number)[];
  readonly expect: string | null;
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const spec = JSON.parse(readFileSync(join(root, 'packages/jetbrains/tools/parity/vectors/hints.json'), 'utf8')) as {
  vectors: Vector[];
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function commentFor(v: Vector): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'asksql-parity-'));
  dirs.push(dir);
  const file = join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, "${v.column}" ${v.dbType})`);
  const stmt = db.prepare(`INSERT INTO t ("${v.column}") VALUES (?)`);
  for (const row of v.rows) stmt.run(row as string | number);
  db.close();

  const connector = new SqliteConnector({ id: 't', name: 't', file });
  await connector.connect();
  const catalog = await connector.introspect();
  await connector.close();
  const column = catalog.tables.find((t) => t.name === 't')?.columns.find((c) => c.name === v.column);
  return column?.comment ?? null;
}

describe('the derived hints match the shared specification', () => {
  it('has vectors to check, so an empty file cannot pass silently', () => {
    expect(spec.vectors.length).toBeGreaterThan(15);
  });

  for (const vector of spec.vectors) {
    it(vector.name, async () => {
      expect(await commentFor(vector)).toBe(vector.expect);
    });
  }
});
