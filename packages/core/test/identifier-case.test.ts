import { describe, expect, it } from 'vitest';
import { pruneCatalog } from '../src/catalog.js';
import { buildSqlUser } from '../src/prompt.js';
import { POSTGRES_DIALECT } from '../src/dialects.js';
import {
  correctTableCase,
  hasUnterminatedLiteral,
  looksLikeUnknownTable,
  quoteCatalogIdentifiers,
} from '../src/identifier-case.js';

const TABLES = ['Customers', 'OrderItems'];

describe('correctTableCase', () => {
  it('corrects a lower-cased table name', () => {
    expect(correctTableCase('SELECT * FROM customers', TABLES, '`')).toBe('SELECT * FROM `Customers`');
  });

  it('corrects an upper-cased table name after JOIN', () => {
    const sql = 'SELECT * FROM Customers c JOIN ORDERITEMS o ON c.id = o.id';
    expect(correctTableCase(sql, TABLES, '`')).toBe('SELECT * FROM Customers c JOIN `OrderItems` o ON c.id = o.id');
  });

  it('leaves an alias after the table alone', () => {
    expect(correctTableCase('SELECT * FROM orderitems oi', TABLES, '`')).toBe('SELECT * FROM `OrderItems` oi');
  });

  it('returns null when every name already matches', () => {
    expect(correctTableCase('SELECT * FROM Customers', TABLES, '`')).toBeNull();
  });

  it('quotes with the dialect character', () => {
    expect(correctTableCase('SELECT * FROM customers', TABLES, '"')).toBe('SELECT * FROM "Customers"');
  });

  it('corrects a name that was already quoted in the wrong case', () => {
    expect(correctTableCase('SELECT * FROM `customers`', TABLES, '`')).toBe('SELECT * FROM `Customers`');
  });

  it('keeps a schema prefix and corrects only the table', () => {
    expect(correctTableCase('SELECT * FROM shop.orderitems', TABLES, '`')).toBe('SELECT * FROM shop.`OrderItems`');
  });

  /** A column sharing a table's name must not be rewritten: it is not in table position. */
  it('leaves a same-named column alone', () => {
    expect(correctTableCase('SELECT customers FROM Customers', TABLES, '`')).toBeNull();
  });

  /** Rewriting inside a literal would change the query's meaning, not just its spelling. */
  it('leaves a string literal alone', () => {
    expect(correctTableCase("SELECT * FROM Customers WHERE note = 'from customers'", TABLES, '`')).toBeNull();
  });

  /** Two tables differing only by case have no single right answer. */
  it('leaves an ambiguous fold untouched', () => {
    expect(correctTableCase('SELECT * FROM orders', ['Orders', 'ORDERS'], '`')).toBeNull();
  });

  it('corrects an UPDATE target', () => {
    expect(correctTableCase('UPDATE customers SET x = 1', TABLES, '`')).toBe('UPDATE `Customers` SET x = 1');
  });

  it('leaves an unknown table alone', () => {
    expect(correctTableCase('SELECT * FROM invoices', TABLES, '`')).toBeNull();
  });
});

describe('looksLikeUnknownTable', () => {
  it.each([
    "Table 'asksql_test.customers' doesn't exist",
    'relation "customers" does not exist',
    'no such table: customers',
    'ORA-00942: table or view does not exist',
    'Invalid object name customers.',
  ])('recognises %s', (message) => {
    expect(looksLikeUnknownTable(message)).toBe(true);
  });

  it('does not fire on an unrelated failure', () => {
    expect(looksLikeUnknownTable('Unknown column x in field list')).toBe(false);
  });
});

describe('folding engines', () => {
  /** Postgres folds an unquoted name to lower case, so a mixed-case table needs quoting even when spelled right. */
  it('quotes a correctly spelled mixed-case table on Postgres', () => {
    expect(correctTableCase('SELECT * FROM Customers', TABLES, '"', 'lower')).toBe('SELECT * FROM "Customers"');
  });

  it('leaves an all-lower-case table alone on Postgres', () => {
    expect(correctTableCase('SELECT * FROM orders', ['orders'], '"', 'lower')).toBeNull();
  });

  /** Unquoted Orders folds to orders, which is the catalog table, so nothing needs changing. */
  it('leaves a name the fold already resolves alone on Postgres', () => {
    expect(correctTableCase('SELECT * FROM Orders', ['orders'], '"', 'lower')).toBeNull();
  });

  it('leaves an already quoted mixed-case name alone on Postgres', () => {
    expect(correctTableCase('SELECT * FROM "Customers"', TABLES, '"', 'lower')).toBeNull();
  });

  it('quotes a mixed-case table on Oracle, which folds upper', () => {
    expect(correctTableCase('SELECT * FROM MixedCase', ['MixedCase'], '"', 'upper')).toBe('SELECT * FROM "MixedCase"');
  });

  it('leaves an upper-case Oracle table alone', () => {
    expect(correctTableCase('SELECT * FROM employees', ['EMPLOYEES'], '"', 'upper')).toBeNull();
  });
});

describe('quoteCatalogIdentifiers', () => {
  const NAMES = ['Customers', 'OrderItems', 'FirstName', 'Country', 'CustomerId'];
  const q = (sql: string) => quoteCatalogIdentifiers(sql, NAMES, '"');

  it('quotes both the table and the columns', () => {
    expect(q("SELECT FirstName FROM Customers WHERE Country = 'UK'")).toBe(
      `SELECT "FirstName" FROM "Customers" WHERE "Country" = 'UK'`,
    );
  });

  it('quotes a qualified column', () => {
    expect(q('SELECT c.CustomerId FROM Customers c')).toBe('SELECT c."CustomerId" FROM "Customers" c');
  });

  /** Doubling the quotes would make the identifier unreadable. */
  it('leaves an already quoted identifier alone', () => {
    expect(q('SELECT "FirstName" FROM "Customers"')).toBeNull();
  });

  /** A reserved word used as a function must not become an identifier. */
  it('leaves a function call alone', () => {
    expect(quoteCatalogIdentifiers('SELECT COUNT(*) FROM Customers', ['Customers', 'count'], '"')).toBe(
      'SELECT COUNT(*) FROM "Customers"',
    );
  });

  it('leaves a string literal alone', () => {
    expect(q("SELECT 1 WHERE x = 'FirstName'")).toBeNull();
  });

  it('returns null when nothing needs quoting', () => {
    expect(quoteCatalogIdentifiers('SELECT id FROM orders', [], '"')).toBeNull();
  });

  /** A reserved word is quoted too, not only a folded name. */
  /** A table called "order" once turned ORDER BY into "order" BY, which the guard then rejected. */
  it('does not rewrite a keyword that is not naming the table', () => {
    expect(quoteCatalogIdentifiers('SELECT x FROM Customers ORDER BY x DESC', ['Customers', 'order'], '"')).toBe(
      'SELECT x FROM "Customers" ORDER BY x DESC',
    );
  });

  it('still quotes GROUP BY and other keyword-adjacent columns', () => {
    expect(quoteCatalogIdentifiers('SELECT Country FROM t GROUP BY Country', ['Country'], '"')).toBe(
      'SELECT "Country" FROM t GROUP BY "Country"',
    );
  });

  /** A table called Nulls broke the parser: NULLS is a keyword, so the bare name would not parse. */
  it('quotes a table named like a parser keyword', () => {
    expect(quoteCatalogIdentifiers('SELECT Val FROM Nulls', ['Nulls', 'Val'], '"')).toBe('SELECT "Val" FROM "Nulls"');
  });

  it('quotes a table whose name is a reserved word', () => {
    expect(quoteCatalogIdentifiers('SELECT * FROM order', ['order'], '"')).toBe('SELECT * FROM "order"');
  });
});

describe('schema text quoting', () => {
  /** Index columns arrive already quoted from introspection, and were being quoted a second time. */
  it('does not double-quote a name that is already quoted', () => {
    const text = pruneCatalog(
      {
        engine: 'postgres',
        schemas: ['public'],
        tables: [
          {
            name: 'Customers',
            kind: 'table',
            columns: [{ name: 'CustomerId', dbType: 'integer', nullable: false }],
            primaryKey: ['CustomerId'],
            foreignKeys: [],
            uniques: [],
            checks: [],
            indexes: [{ name: 'Customers_pkey', columns: ['"CustomerId"'], unique: true }],
            source: 'db',
          },
        ],
        enums: [],
        sequences: [],
        triggers: [],
        routines: [],
        warnings: [],
        fetchedAt: 'now',
      } as never,
      'customers',
    ).schemaText;

    expect(text).not.toContain('"""');
    expect(text).toContain('"CustomerId"');
  });
});

describe('connection identity in the prompt', () => {
  /** Without the real name a model writes table_schema = 'your_database_name', which silently returns nothing. */
  it('names the database and schema so system-catalog filters are real', () => {
    const text = buildSqlUser({
      question: 'what views exist?',
      schemaText: 'TABLE film',
      dialect: POSTGRES_DIALECT,
      maxRows: 100,
      database: 'sakila',
      schemas: ['public'],
    });

    expect(text).toContain('"sakila"');
    expect(text).toContain('"public"');
    expect(text).toMatch(/never write a placeholder/i);
  });

  it('says nothing when the connection does not report a database', () => {
    const text = buildSqlUser({ question: 'q', schemaText: 's', dialect: POSTGRES_DIALECT, maxRows: 10 });
    expect(text).not.toMatch(/You are connected to/);
  });
});

describe('catalog hint for structure questions', () => {
  /** System-catalog columns are not in the schema block, so the model used to guess them. */
  it('offers a correct catalog query when one is given', () => {
    const text = buildSqlUser({
      question: 'what tables exist?',
      schemaText: 'TABLE film',
      dialect: POSTGRES_DIALECT,
      maxRows: 100,
      catalogHint: 'SELECT table_name FROM information_schema.tables',
    });

    expect(text).toContain('SELECT table_name FROM information_schema.tables');
  });

  it('says nothing about structure for an ordinary data question', () => {
    const text = buildSqlUser({ question: 'how many films?', schemaText: 's', dialect: POSTGRES_DIALECT, maxRows: 10 });
    expect(text).not.toMatch(/about the database's structure/);
  });
});

describe('escaped quotes inside literals', () => {
  const NAMES = ['Notes', 'Body', 'Customers', 'Author'];

  /** A doubled quote is SQL's escaped apostrophe; treating it as the close rewrote text inside the value. */
  it('does not rewrite identifiers inside a literal containing an escaped quote', () => {
    const sql = "SELECT * FROM Notes WHERE Body = 'it''s about Customers' AND Author = 'x'";

    expect(quoteCatalogIdentifiers(sql, NAMES, '"')).toBe(
      'SELECT * FROM "Notes" WHERE "Body" = \'it\'\'s about Customers\' AND "Author" = \'x\'',
    );
  });

  it('keeps scanning as code after the literal really ends', () => {
    const sql = "SELECT Body FROM Notes WHERE Author = 'o''brien'";
    expect(quoteCatalogIdentifiers(sql, NAMES, '"')).toBe('SELECT "Body" FROM "Notes" WHERE "Author" = \'o\'\'brien\'');
  });

  /** correctTableCase shares the scanner, so it has the same hazard. */
  it('leaves a table name inside an escaped literal alone when repairing case', () => {
    const sql = "SELECT * FROM notes WHERE Body = 'it''s notes'";
    expect(correctTableCase(sql, ['Notes'], '"', 'lower')).toBe("SELECT * FROM \"Notes\" WHERE Body = 'it''s notes'");
  });
});

describe('keywords that are syntax, not names', () => {
  const NAMES = ['Date', 'Status', 'Orders', 'Month', 'Amount', 'order'];
  const q = (sql: string) => quoteCatalogIdentifiers(sql, NAMES, '"');

  /** Quoting the type turns CAST(x AS DATE) into a reference to a column that does not exist. */
  it('leaves the type in a CAST alone', () => {
    expect(q('SELECT CAST(x AS Date) FROM t')).toBeNull();
  });

  /** EXTRACT's first argument is a field keyword; the source after FROM is a real column. */
  it('quotes the source of an EXTRACT but not the field', () => {
    expect(q('SELECT EXTRACT(month FROM Date) FROM t')).toBe('SELECT EXTRACT(month FROM "Date") FROM t');
  });

  it('leaves the leading keyword of a TRIM alone', () => {
    expect(q("SELECT TRIM(both 'x' FROM Status) FROM t")).toBe('SELECT TRIM(both \'x\' FROM "Status") FROM t');
  });

  it('still quotes a reserved word in table position', () => {
    expect(q('SELECT * FROM order')).toBe('SELECT * FROM "order"');
  });

  it('still quotes a reserved word qualified by a dot', () => {
    expect(q('SELECT t.order FROM t')).toBe('SELECT t."order" FROM t');
  });

  it('still quotes an ordinary column inside a function call', () => {
    expect(q('SELECT COUNT(Amount) FROM Orders')).toBe('SELECT COUNT("Amount") FROM "Orders"');
  });
});

describe('unterminated text values', () => {
  /** 'O'Brien' is what a model writes when it forgets to double the apostrophe. */
  it('spots an unescaped apostrophe', () => {
    expect(hasUnterminatedLiteral("SELECT Note FROM Person WHERE Name = 'O'Brien'")).toBe(true);
  });

  it('accepts a correctly doubled apostrophe', () => {
    expect(hasUnterminatedLiteral("SELECT Note FROM Person WHERE Name = 'O''Brien'")).toBe(false);
  });

  it.each([
    "SELECT * FROM t WHERE a = 'x' AND b = 'y'",
    'SELECT * FROM t',
    "SELECT * FROM t -- it's fine",
    "SELECT * FROM t /* it's fine */",
  ])('accepts %s', (sql) => {
    expect(hasUnterminatedLiteral(sql)).toBe(false);
  });

  it('spots a value that runs off the end', () => {
    expect(hasUnterminatedLiteral("SELECT * FROM t WHERE a = 'oops")).toBe(true);
  });
});

describe('literals and qualifiers the rewriter must not touch', () => {
  const NAMES = ['Users', 'Notes', 'Sales'];

  /** Postgres and DuckDB dollar-quote bodies, which may contain anything at all. */
  it('leaves a dollar-quoted body alone', () => {
    expect(quoteCatalogIdentifiers('SELECT * FROM Users WHERE Notes = $$from users now$$', NAMES, '"')).toBe(
      'SELECT * FROM "Users" WHERE "Notes" = $$from users now$$',
    );
  });

  it('leaves a tagged dollar-quoted body alone', () => {
    expect(quoteCatalogIdentifiers('SELECT * FROM Users WHERE Notes = $x$from users$x$', NAMES, '"')).toBe(
      'SELECT * FROM "Users" WHERE "Notes" = $x$from users$x$',
    );
  });

  /** Quoting a schema qualifier turns a working query into "schema does not exist". */
  it('does not quote a qualifier that is not a table', () => {
    expect(quoteCatalogIdentifiers('SELECT * FROM sales.orders', ['Sales'], '"', [])).toBeNull();
  });

  /**
   * After FROM the qualifier is a SCHEMA, so a table of the same name must not lend it its casing.
   * Verified against Postgres: a schema `sales` beside a table `Sales` turned a working query into
   * `relation "Sales.orders" does not exist`.
   */
  it('does not quote a FROM qualifier even when a table shares the name', () => {
    expect(quoteCatalogIdentifiers('SELECT SUM(amount) FROM sales.orders', ['Sales'], '"', ['Sales'])).toBeNull();
    expect(quoteCatalogIdentifiers('SELECT * FROM a JOIN sales.orders ON 1=1', ['Sales'], '"', ['Sales'])).toBeNull();
    // The table after the dot is still corrected; only the schema is left alone.
    expect(quoteCatalogIdentifiers('SELECT * FROM sales.orders', ['Sales', 'Orders'], '"', ['Sales', 'Orders'])).toBe(
      'SELECT * FROM sales."Orders"',
    );
  });

  it('still quotes a qualifier that is a real table', () => {
    expect(
      quoteCatalogIdentifiers('SELECT Customers.FirstName FROM Customers', ['Customers', 'FirstName'], '"', [
        'Customers',
      ]),
    ).toBe('SELECT "Customers"."FirstName" FROM "Customers"');
  });

  /** In prod.sales.orders the table is orders; sales is a qualifier. */
  it('does not recase the middle of a three-part name', () => {
    expect(correctTableCase('SELECT * FROM prod.sales.orders', ['Sales'], '"', 'lower')).toBeNull();
  });
});

describe('dialect-specific literal rules', () => {
  const BS = String.fromCharCode(92);

  /** Backslash escapes a quote in MySQL only; Postgres, Oracle, SQLite and DuckDB read it literally. */
  it('treats a backslash as an escape only for the backtick dialect', () => {
    expect(hasUnterminatedLiteral(`SELECT * FROM t WHERE n = 'O${BS}'Brien'`, true)).toBe(false);
    expect(hasUnterminatedLiteral(`SELECT * FROM t WHERE n = 'O${BS}'Brien'`)).toBe(true);
  });

  it('still spots a genuinely unescaped apostrophe', () => {
    expect(hasUnterminatedLiteral("SELECT * FROM t WHERE n = 'O'Brien'")).toBe(true);
  });

  /** A dollar-quoted body needs no escaping, so an apostrophe inside it is not a defect. */
  it('does not flag an apostrophe inside a dollar-quoted body', () => {
    expect(hasUnterminatedLiteral("SELECT * FROM t WHERE n = $$don't$$")).toBe(false);
  });

  /** TIMESTAMP '2024-01-01' is one typed literal; quoting the word makes it a missing column. */
  it.each([
    ["SELECT * FROM t WHERE created > TIMESTAMP '2024-01-01'", 'Timestamp'],
    ["SELECT * FROM t WHERE d > DATE '2024-01-01'", 'Date'],
  ])('leaves a typed literal alone: %s', (sql, name) => {
    expect(quoteCatalogIdentifiers(sql, [name], '"')).toBeNull();
  });

  it('still quotes the same word used as a real column', () => {
    expect(quoteCatalogIdentifiers('SELECT Timestamp FROM t', ['Timestamp'], '"')).toBe('SELECT "Timestamp" FROM t');
  });
});

describe('names split across literal boundaries', () => {
  const NAMES = ['Customers', 'FirstName', 'Country', 'City', 'Timestamp'];

  /**
   * Literals split the statement into segments, and the typed-literal check reads the whole
   * statement rather than one segment. If it read the segment, every name sitting at a segment
   * boundary would silently stop being quoted.
   */
  it('quotes names before, between and after several literals', () => {
    const sql = "SELECT FirstName FROM Customers WHERE Country = 'UK' AND City = 'York' AND FirstName <> 'x'";

    expect(quoteCatalogIdentifiers(sql, NAMES, '"')).toBe(
      'SELECT "FirstName" FROM "Customers" WHERE "Country" = \'UK\' AND "City" = \'York\' AND "FirstName" <> \'x\'',
    );
  });

  it('quotes a name that ends the statement, with a literal earlier', () => {
    expect(quoteCatalogIdentifiers("SELECT * FROM Customers WHERE Country = 'UK' ORDER BY City", NAMES, '"')).toBe(
      'SELECT * FROM "Customers" WHERE "Country" = \'UK\' ORDER BY "City"',
    );
  });

  /** The one word that must not be quoted is the one a literal directly follows. */
  it('skips only the typed literal, quoting every other name in the same statement', () => {
    const sql = "SELECT FirstName FROM Customers WHERE created > TIMESTAMP '2024-01-01'";

    expect(quoteCatalogIdentifiers(sql, NAMES, '"')).toBe(
      'SELECT "FirstName" FROM "Customers" WHERE created > TIMESTAMP \'2024-01-01\'',
    );
  });
});
