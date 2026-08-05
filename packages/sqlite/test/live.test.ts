/**
 * SQLite connector via the built-in node:sqlite driver.
 * Covers introspection (tables/views/triggers/FK/index) + querying +
 * read-only enforcement + guard integration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SqliteConnector } from '../src/index.js';
import { guardSql, SQLITE_DIALECT } from '@asksql/core';

// node:sqlite StatementSync.all() matches the SqliteDriver shape.
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, born INTEGER);
    CREATE TABLE books (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES authors(id),
      price REAL, isbn TEXT UNIQUE
    );
    CREATE INDEX ix_books_author ON books(author_id);
    CREATE VIEW expensive_books AS SELECT * FROM books WHERE price > 20;
    CREATE TRIGGER trg_books_ai AFTER INSERT ON books BEGIN SELECT 1; END;
    INSERT INTO authors (name, born) VALUES ('Ursula K. Le Guin', 1929), ('Ted Chiang', 1967);
    INSERT INTO books (title, author_id, price, isbn) VALUES
      ('The Dispossessed', 1, 15.99, 'A1'),
      ('Exhalation', 2, 25.00, 'B2'),
      ('The Left Hand of Darkness', 1, 22.50, 'C3');
  `);
  return db;
}

let conn: SqliteConnector;
beforeAll(async () => {
  conn = new SqliteConnector({ id: 'lite', name: 'Library', database: makeDb() as never });
  await conn.connect();
});

describe('SQLite introspection', () => {
  it('captures tables, view, PK, FK, index, unique', async () => {
    const cat = await conn.introspect();
    const books = cat.tables.find((t) => t.name === 'books')!;
    expect(books.primaryKey).toEqual(['id']);
    expect(books.foreignKeys[0]).toMatchObject({ refTable: 'authors', columns: ['author_id'] });
    expect(books.indexes.some((i) => i.name === 'ix_books_author')).toBe(true);
    expect(books.uniques.flat()).toContain('isbn');
    const view = cat.tables.find((t) => t.name === 'expensive_books');
    expect(view?.kind).toBe('view');
  });

  it('captures triggers', async () => {
    const cat = await conn.introspect();
    const trg = cat.triggers.find((t) => t.name === 'trg_books_ai')!;
    expect(trg.table).toBe('books');
    expect(trg.timing).toBe('AFTER');
    expect(trg.events).toContain('INSERT');
  });
});

describe('SQLite query + guard', () => {
  it('runs a join', async () => {
    const res = await conn.execute(
      'SELECT a.name, count(b.id) n FROM authors a JOIN books b ON b.author_id=a.id GROUP BY a.name ORDER BY n DESC',
    );
    expect(res.rowCount).toBe(2);
    expect(res.rows[0]![1]).toBe(2); // Le Guin has 2 books
  });

  it('read-only PRAGMA allowed by guard, write PRAGMA blocked', () => {
    expect(guardSql({ sql: 'PRAGMA table_info(books)', dialect: SQLITE_DIALECT }).allowed).toBe(true);
    expect(guardSql({ sql: 'PRAGMA journal_mode=WAL', dialect: SQLITE_DIALECT }).allowed).toBe(false);
  });

  it('row cap truncates', async () => {
    const res = await conn.execute('SELECT * FROM books', { maxRows: 1 });
    expect(res.rowCount).toBe(1);
    expect(res.truncated).toBe(true);
  });

  it('duplicate result-column names keep both columns and warn', async () => {
    // node:sqlite has columns() but no raw(): the object row collapses the two
    // `id`s, so we keep the real column count from metadata and warn the user.
    const res = await conn.execute('SELECT b.id, a.id FROM books b JOIN authors a ON a.id = b.author_id LIMIT 1');
    expect(res.columns.map((c) => c.name)).toEqual(['id', 'id']);
    expect(res.warnings.some((w) => /share a name/i.test(w))).toBe(true);
  });
});

describe('SQLite value sampling (opt-in)', () => {
  function makeSampleDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE tickets (id INTEGER PRIMARY KEY, status TEXT, note TEXT, ref TEXT);
      INSERT INTO tickets (status, note, ref) VALUES
        ('open',   'short', 'r1'),
        ('closed', 'short', 'r2'),
        ('open',   'short', 'r3'),
        ('pending','short', 'r4');
    `);
    return db;
  }

  it('does not sample unless enabled', async () => {
    const c = new SqliteConnector({ id: 's0', name: 'off', database: makeSampleDb() as never });
    await c.connect();
    const cat = await c.introspect();
    const status = cat.tables.find((t) => t.name === 'tickets')!.columns.find((col) => col.name === 'status')!;
    expect(status.sampledValues).toBeUndefined();
  });

  it('samples distinct values of a short low-cardinality text column when enabled', async () => {
    const c = new SqliteConnector({
      id: 's1',
      name: 'on',
      database: makeSampleDb() as never,
      sampleColumnValues: true,
    });
    await c.connect();
    const cat = await c.introspect();
    const status = cat.tables.find((t) => t.name === 'tickets')!.columns.find((col) => col.name === 'status')!;
    expect(status.sampledValues).toBeDefined();
    expect([...status.sampledValues!].sort()).toEqual(['closed', 'open', 'pending']);
  });

  it('skips a high-cardinality column (distinct count over the cap)', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, code TEXT);');
    const stmt = db.prepare('INSERT INTO big (code) VALUES (?)');
    for (let i = 0; i < 40; i++) stmt.run(`code-${i}`);
    const c = new SqliteConnector({ id: 's2', name: 'big', database: db as never, sampleColumnValues: true });
    await c.connect();
    const cat = await c.introspect();
    const code = cat.tables.find((t) => t.name === 'big')!.columns.find((col) => col.name === 'code')!;
    expect(code.sampledValues).toBeUndefined();
  });

  it('does not sample a view (only base tables)', async () => {
    const db = makeSampleDb();
    db.exec('CREATE VIEW tickets_v AS SELECT * FROM tickets;');
    const c = new SqliteConnector({ id: 's3', name: 'view', database: db as never, sampleColumnValues: true });
    await c.connect();
    const cat = await c.introspect();
    const view = cat.tables.find((t) => t.name === 'tickets_v')!;
    expect(view.kind).toBe('view');
    expect(view.columns.find((col) => col.name === 'status')!.sampledValues).toBeUndefined();
  });
});

describe('SQLite 64-bit integer fidelity', () => {
  it('preserves a 64-bit id that a JS number cannot represent', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, n INTEGER, small INTEGER);');
    // 9007199254740993 = 2^53 + 1, the first integer a JS number rounds (to ...992).
    db.exec('INSERT INTO big (id, n, small) VALUES (9007199254740993, 9223372036854775807, 42);');
    const c = new SqliteConnector({ id: 'big64', name: 'big', database: db as never });
    await c.connect();
    const res = await c.execute('SELECT id, n, small FROM big');
    const [id, n, small] = res.rows[0]!;
    expect(id).toBe('9007199254740993');
    expect(n).toBe('9223372036854775807');
    expect(res.columns[0]!.kind).toBe('bigint');
    // An ordinary small integer still comes back as a number, not a string.
    expect(small).toBe(42);
    expect(res.columns[2]!.kind).toBe('number');
  });
});

/**
 * The driver fallback: with no better-sqlite3 installed the connector opens the file with
 * Node's built-in sqlite. What matters is that the fallback keeps the read-only guarantee -
 * the database itself must refuse a write, not just the SQL guard above it.
 */
describe('file mode: built-in node:sqlite fallback', () => {
  const file = join(tmpdir(), `asksql-fallback-${process.pid}.db`);

  beforeAll(() => {
    const seed = new DatabaseSync(file);
    seed.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a')");
    seed.close();
  });
  afterAll(() => {
    rmSync(file, { force: true });
  });

  it('opens a file path, introspects it, and reads rows', async () => {
    const conn = new SqliteConnector({ id: 'f', name: 'F', file });
    await conn.connect();
    try {
      expect((await conn.introspect()).tables.map((t) => t.name)).toContain('t');
      expect((await conn.execute('SELECT v FROM t')).rows).toEqual([['a']]);
    } finally {
      await conn.close();
    }
  });

  // Asserts the guarantee, not a driver's wording: better-sqlite3 and node:sqlite refuse
  // a write with different messages, and either way the row must not appear.
  it('opens the file read-only, so a write that reaches the database is refused', async () => {
    const conn = new SqliteConnector({ id: 'f2', name: 'F2', file });
    await conn.connect();
    try {
      await expect(conn.execute("INSERT INTO t VALUES (2, 'b')")).rejects.toThrow();
      expect((await conn.execute('SELECT count(*) FROM t')).rows.flat().map(String)).toEqual(['1']);
    } finally {
      await conn.close();
    }
  });

  it('reports a missing file as a configuration problem, not a driver problem', async () => {
    const conn = new SqliteConnector({ id: 'f3', name: 'F3', file: join(tmpdir(), 'asksql-does-not-exist.db') });
    await expect(conn.connect()).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
  });
});

/**
 * The read-only assertion is the last line of defence: node:sqlite ignores unknown option
 * keys, so a wrong or unsupported flag opens the file writable with no error anywhere.
 */
describe('read-only assertion', () => {
  const file = join(tmpdir(), `asksql-assert-${process.pid}.db`);

  beforeAll(() => {
    const seed = new DatabaseSync(file);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1)');
    seed.close();
  });
  afterAll(() => rmSync(file, { force: true }));

  /** A driver that opened the file writable and cannot arm query_only - what we must catch. */
  const writableDriver = () => {
    const inner = new DatabaseSync(file);
    return {
      prepare: (sql: string) => (/query_only/i.test(sql) ? { all: () => [{ query_only: 0 }] } : inner.prepare(sql)),
      exec: () => {}, // swallows "PRAGMA query_only = ON", like a driver that does not support it
      close: () => inner.close(),
    };
  };

  it('refuses a handle whose read-only mode cannot be enforced', async () => {
    const conn = new SqliteConnector({ id: 'w', name: 'W', database: writableDriver() as never });
    await expect(conn.connect()).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      // A handle the caller opened gets its own wording: telling them to upgrade Node or install
      // a driver makes no sense for a connection they created themselves.
      userMessage: expect.stringMatching(/handle passed to AskSQL could not be put into read-only/i),
    });
  });

  it('does not leave the rejected handle in service for the next connect()', async () => {
    const conn = new SqliteConnector({ id: 'w2', name: 'W2', database: writableDriver() as never });
    await expect(conn.connect()).rejects.toThrow(/read-only mode/i);
    // The bug this guards: connect() returned early on the retained handle and served queries.
    await expect(conn.connect()).rejects.toThrow(/read-only mode/i);
  });

  it('accepts a genuinely read-only caller handle', async () => {
    const conn = new SqliteConnector({
      id: 'r',
      name: 'R',
      database: new DatabaseSync(file, { readOnly: true }) as never,
    });
    await expect(conn.connect()).resolves.toBeUndefined();
    expect((await conn.execute('SELECT count(*) FROM t')).rows.flat().map(String)).toEqual(['1']);
    await conn.close();
  });

  // `query_only` belongs to the CONNECTION, and a caller-supplied handle is the host
  // application's connection. Arming it and walking away left the host unable to write through
  // its own handle for the rest of the process's life.
  it('gives a caller-supplied handle back able to write again', async () => {
    const hostDb = new DatabaseSync(file);
    const conn = new SqliteConnector({ id: 'h', name: 'H', database: hostDb as never });
    await conn.connect();
    // While AskSQL holds it, the handle really is read-only.
    expect(() => hostDb.exec('INSERT INTO t VALUES (99)')).toThrow();
    await conn.close();
    // And afterwards the host has its connection back exactly as it lent it.
    hostDb.exec('INSERT INTO t VALUES (99)');
    expect(hostDb.prepare('SELECT count(*) AS n FROM t').get()).toMatchObject({ n: 2 });
    hostDb.exec('DELETE FROM t WHERE id = 99');
    hostDb.close();
  });

  // The handle reaches `this.db` straight from the constructor, so nothing had proven it
  // read-only if a caller went straight to execute().
  it('refuses to query a caller-supplied handle before connect() has verified it', async () => {
    const hostDb = new DatabaseSync(file);
    const conn = new SqliteConnector({ id: 'u', name: 'U', database: hostDb as never });
    await expect(conn.execute('SELECT count(*) FROM t')).rejects.toMatchObject({ code: 'DB_UNREACHABLE' });
    // The host handle is untouched by the refusal: it can still write.
    hostDb.exec('INSERT INTO t VALUES (98)');
    hostDb.exec('DELETE FROM t WHERE id = 98');
    hostDb.close();
  });
});
