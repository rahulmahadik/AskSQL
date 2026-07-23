/**
 * SQLite connector via the built-in node:sqlite driver.
 * Covers introspection (tables/views/triggers/FK/index) + querying +
 * read-only enforcement + guard integration.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
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
