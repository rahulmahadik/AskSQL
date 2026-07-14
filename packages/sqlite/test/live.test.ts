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
    const res = await conn.execute('SELECT a.name, count(b.id) n FROM authors a JOIN books b ON b.author_id=a.id GROUP BY a.name ORDER BY n DESC');
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
});
