/**
 * A Room TypeConverter writes JSON into a TEXT column and the schema says nothing about it, so the
 * model invented a key and matched with LIKE: measured on the Room fixture it answered 0, truth 2.
 * Naming the keys fixed the answer but left LIKE in the query, which a single space after a colon
 * defeats silently, so the hint names json_extract too. Keys are schema; values are data and stay in
 * the database.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteConnector } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A one-column table holding `values`, introspected; returns the comment the model would be shown. */
async function commentFor(
  values: string[],
  dbType = 'TEXT',
  sampleColumnValues = false,
): Promise<string | null | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'asksql-json-'));
  dirs.push(dir);
  const file = join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, prefs ${dbType})`);
  const stmt = db.prepare('INSERT INTO t (prefs) VALUES (?)');
  for (const v of values) stmt.run(v);
  db.close();

  const connector = new SqliteConnector({ id: 't', name: 't', file, sampleColumnValues });
  await connector.connect();
  const catalog = await connector.introspect();
  await connector.close();
  return catalog.tables.find((t) => t.name === 't')?.columns.find((c) => c.name === 'prefs')?.comment;
}

describe('a TEXT column holding JSON is described by its keys', () => {
  const RECORD = ['{"theme":"dark","notify":true}', '{"theme":"light","notify":false}', '{"theme":"dark"}'];

  it('points at json_extract and counts the recurring keys, without naming them', async () => {
    // A map with a stable key set has perfect recurrence too, so the names are cell data and ride the
    // same opt-in. The accessor is structure and is what stopped the model reaching for LIKE.
    const comment = await commentFor(RECORD);
    expect(comment).toContain('json_extract');
    expect(comment).toContain('2 recurring keys');
    expect(comment).not.toContain('theme');
  });

  it('names them once the host opts into cell values', async () => {
    const comment = await commentFor(RECORD, 'TEXT', true);
    expect(comment).toContain('theme');
    expect(comment).toContain('notify');
  });

  it('never repeats a value, even under the opt-in', async () => {
    const rows = [
      '{"theme":"dark","email":"ada@example.com"}',
      '{"theme":"light","email":"grace@example.com"}',
      '{"theme":"dark","email":"linus@example.com"}',
    ];
    for (const optIn of [false, true]) {
      const comment = await commentFor(rows, 'TEXT', optIn);
      expect(comment, String(optIn)).not.toContain('dark');
      expect(comment, String(optIn)).not.toContain('ada@example.com');
    }
  });

  it('reports only top-level keys, skipping nested objects and arrays', async () => {
    const comment = await commentFor(Array(3).fill('{"a":{"b":1},"c":[1,2],"d":"x:y{"}'), 'TEXT', true);
    expect(comment).toMatch(/keys: a, c, d$/);
  });

  it('stays under the schema builder cap, trimming whole keys rather than half of one', async () => {
    // A comment past 200 characters is truncated with an ellipsis, which would offer a key that does
    // not exist. The list must end at a key boundary.
    const long = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field_name_${i}`, i]));
    const comment = (await commentFor(Array(3).fill(JSON.stringify(long)), 'TEXT', true))!;
    expect(comment.length).toBeLessThanOrEqual(200);
    expect(comment).toMatch(/, \.\.\.$/); // trimmed, and visibly so
    for (const key of comment.split('keys: ')[1].split(', ').filter((k) => k !== '...')) {
      expect(Object.keys(long)).toContain(key); // never a half name
    }
  });

  it('applies to the JSON and VARCHAR types Room schemas also use', async () => {
    for (const dbType of ['VARCHAR(255)', 'JSON', 'CLOB']) {
      const rows = ['{"theme":"dark","notify":true}', '{"theme":"light","notify":false}', '{"theme":"dark","notify":true}'];
      expect(await commentFor(rows, dbType, true), dbType).toContain('theme');
    }
  });
});

describe('a column that is not a fixed JSON shape is left undescribed', () => {
  it('says nothing about a map keyed by user data', async () => {
    // The shape that would turn this hint into a value leak: the keys ARE the data.
    const comment = await commentFor(['{"ada@example.com":3,"grace@example.com":5}']);
    expect(comment).toBeFalsy();
  });

  it('never names an identifier-shaped key that is really a username', async () => {
    // A username passes the field-name test, so shape alone cannot reject it. Reuse can: these keys
    // each appear on exactly one row, which is a map, not a record.
    const comment = await commentFor(['{"ZZALICE":3}', '{"ZZBOB":7}', '{"ZZCAROL":1}']);
    expect(comment).toContain('json_extract'); // the accessor is still worth saying
    for (const who of ['ZZALICE', 'ZZBOB', 'ZZCAROL']) expect(comment, who).not.toContain(who);
  });

  it('never names the key of a single-tenant map, which recurs but is still data', async () => {
    const comment = await commentFor(['{"ZZACME":1}', '{"ZZACME":2}', '{"ZZACME":3}']);
    expect(comment).not.toContain('ZZACME');
  });

  it('names nothing until reuse can actually be observed', async () => {
    const comment = await commentFor(['{"theme":"dark","notify":true}', '{"theme":"light","notify":false}']);
    expect(comment).toContain('json_extract');
    expect(comment).not.toContain('keys:');
  });

  it('says nothing when a key is a uuid or an id', async () => {
    expect(await commentFor(['{"3f2b8c14-9a77-4d3e-8f1a-2b6c9d0e7a55":1}'])).toBeFalsy();
    expect(await commentFor(['{"1":"a","2":"b"}'])).toBeFalsy();
  });

  it('says nothing at all about ordinary text or malformed JSON', async () => {
    expect(await commentFor(['Let It Be'])).toBeFalsy();
    expect(await commentFor(['{not json'])).toBeFalsy();
  });

  it('describes a JSON array by its element type rather than by keys', async () => {
    const comment = await commentFor(['[1,2]', '[3]', '[]']);
    expect(comment).toMatch(/JSON array of numbers/);
    expect(comment).toContain('json_each');
  });

  it('offers the accessor but no key for an object that carries none', async () => {
    const comment = await commentFor(['{}', '{}', '{}']);
    expect(comment).toContain('json_extract');
    expect(comment).not.toContain('keys:');
  });

  it('says nothing when only some rows are JSON', async () => {
    expect(await commentFor(['{"a":1}', 'plain text'])).toBeFalsy();
  });

  it('names no key when the shape is too wide to be a fixed record', async () => {
    const wide = `{${Array.from({ length: 20 }, (_, i) => `"k${i}":${i}`).join(',')}}`;
    const comment = await commentFor(Array(3).fill(wide));
    expect(comment).toContain('json_extract');
    expect(comment).not.toContain('keys:');
  });

  it('says nothing about an empty table', async () => {
    expect(await commentFor([])).toBeFalsy();
  });
});
