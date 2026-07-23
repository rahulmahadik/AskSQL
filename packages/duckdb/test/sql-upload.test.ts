/**
 * .sql file upload: a non-technical user has a SQL dump but no live database.
 * A portable dump (CREATE TABLE + INSERT) loads and becomes queryable; vendor
 * dumps DuckDB cannot parse, and any file/network statement, are rejected with
 * a clear message BEFORE anything runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDbConnector } from '../src/index.js';

let available = true;
let conn: DuckDbConnector;
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'asksql-sql-'));
  conn = new DuckDbConnector({ id: 'sql', name: 'SQL' });
  try {
    await conn.connect();
  } catch (err) {
    available = false;
    console.warn('[skip] duckdb sql-upload test:', (err as Error).message);
  }
});
afterAll(async () => {
  await conn.close();
  await rm(tmp, { recursive: true, force: true });
});

const maybe = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!available) return;
    await fn();
  });

async function sqlFile(name: string, content: string): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, content, 'utf8');
  return p;
}

describe('portable .sql dump', () => {
  maybe('loads a CREATE + INSERT script and queries it', async () => {
    const p = await sqlFile(
      'shop.sql',
      `CREATE TABLE customers (id INTEGER, name VARCHAR, tier VARCHAR);
       INSERT INTO customers VALUES (1,'Ada','gold'),(2,'Grace','silver'),(3,'Kat','gold');`,
    );
    const table = await conn.registerFile({ table: 'ignored', path: p }); // format sniffed from .sql
    expect(table).toBe('customers');

    const cat = await conn.introspect();
    const t = cat.tables.find((x) => x.name === 'customers');
    expect(t).toBeTruthy();
    expect(t!.source).toBe('file');

    const res = await conn.execute("SELECT count(*) AS n FROM customers WHERE tier = 'gold'");
    expect(Number(res.rows[0]![0])).toBe(2);
  });
});

describe('vendor dumps are rejected with a helpful message', () => {
  maybe('mysqldump (backticks/ENGINE) names MySQL', async () => {
    const p = await sqlFile(
      'mysql.sql',
      'CREATE TABLE `users` (`id` int(11) NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB;',
    );
    await expect(conn.registerFile({ table: 'u', path: p })).rejects.toThrow(/MySQL|mysqldump/i);
  });

  maybe('pg_dump (COPY FROM stdin) names PostgreSQL', async () => {
    const p = await sqlFile('pg.sql', 'CREATE TABLE t (id integer);\nCOPY t (id) FROM stdin;\n1\n\\.\n');
    await expect(conn.registerFile({ table: 't', path: p })).rejects.toThrow(/PostgreSQL|pg_dump/i);
  });
});

describe('file/network statements are blocked', () => {
  maybe('read_csv on an arbitrary path is refused', async () => {
    const p = await sqlFile('bad.sql', "CREATE TABLE leak AS SELECT * FROM read_csv('/etc/passwd');");
    await expect(conn.registerFile({ table: 'x', path: p })).rejects.toThrow(/not allowed|READ_CSV/i);
  });

  maybe('ATTACH is refused', async () => {
    const p = await sqlFile('attach.sql', "ATTACH 'other.duckdb'; CREATE TABLE t (id int);");
    await expect(conn.registerFile({ table: 't', path: p })).rejects.toThrow(/not allowed|ATTACH/i);
  });

  maybe('a script that creates no tables is refused', async () => {
    const p = await sqlFile('empty.sql', 'SELECT 1;');
    await expect(conn.registerFile({ table: 't', path: p })).rejects.toThrow(/created no tables/i);
  });
});
