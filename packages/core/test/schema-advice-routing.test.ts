/**
 * Question routing: data -> SQL, advice -> prose, write request -> proposal, listing -> catalog
 * query. A misrouted advice question comes back as an information_schema listing, which runs and
 * reads as an answer to something the user never asked.
 */
import { describe, expect, it } from 'vitest';
import { isMetadataQuestion, isSchemaAdviceQuestion, isWriteRequest } from '../src/schema-match.js';
import { buildSchemaAnswerUser } from '../src/prompt.js';
import { extractSql } from '../src/extract.js';

describe('advice questions route to prose', () => {
  const ADVICE = [
    // Both phrasings that produced `SELECT table_name FROM information_schema.tables`.
    'can you check if i wants improve db schema what are the possiblities',
    'can you please review the db schema and tell me to improve relations between tables what needs to update',
    'how can I improve the relationships between these tables',
    'review my schema and suggest indexes',
    'what is wrong with this database structure',
    'should I normalize the customers table',
    'any problems with my foreign keys',
    'what needs to be fixed in this schema',
    // Performance and query design, not just structure.
    'how can I improve the performance of this query',
    'which indexes should I add to speed up these joins',
    'this query is slow, how do I optimize it',
    'recommend a partitioning strategy for the orders table',
    'is my data model missing any constraints',
    'suggest better indexing for the join between orders and customers',
    'tune the database for faster reads',
    'audit the schema design',
    // Beyond "write me a query": the rest of what people bring to an AI about a database.
    'why is this query slow',
    'explain this query to me',
    'convert this MySQL query to Postgres',
    'rewrite this query without a subquery',
    'what is the difference between a view and a materialized view in this schema',
    'when should I use a composite index here',
    'pros and cons of denormalizing this table',
    'document the schema for a new developer',
    'why does this query return duplicate rows',
    'what is the best index strategy for filtering orders by status and date',
    'how do I make this join faster between products, inventory and warehouses',
  ];
  for (const q of ADVICE) {
    it(`prose: "${q.slice(0, 46)}"`, () => {
      expect(isSchemaAdviceQuestion(q)).toBe(true);
      expect(isMetadataQuestion(q)).toBe(false);
    });
  }
});

describe('write requests route to a proposal', () => {
  const WRITES = [
    'write a statement that deletes cancelled orders',
    'write a query that removes old rows',
    'give me a SQL command to drop the archive table',
    'generate a migration to add a status column',
    'how do I write a query to update prices',
    'draft a script that truncates the staging table',
    'I need a statement to insert a new customer',
  ];
  for (const q of WRITES) {
    it(`proposal: "${q.slice(0, 46)}"`, () => {
      expect(isWriteRequest(q)).toBe(true);
    });
  }

  const NOT_WRITES = [
    'how many orders were deleted last week',
    'show me the cancelled orders',
    'which customers were added in January',
    'what is the total revenue',
  ];
  for (const q of NOT_WRITES) {
    it(`not a write request: "${q}"`, () => {
      expect(isWriteRequest(q)).toBe(false);
    });
  }
});

describe('listing questions still get a catalog query', () => {
  const LISTINGS = [
    'show me all the tables',
    'list the columns in orders',
    'how many tables are there',
    'what views exist in this database',
  ];
  for (const q of LISTINGS) {
    it(`listing: "${q}"`, () => {
      expect(isMetadataQuestion(q)).toBe(true);
      expect(isSchemaAdviceQuestion(q)).toBe(false);
    });
  }
});

describe('ordinary data questions are left to SQL generation', () => {
  const DATA = [
    'how many orders were placed last week',
    'total revenue by region',
    'which customers have no orders',
    // Advice-flavoured wording with no schema object in sight: still about rows.
    'which region performed better last quarter',
    'show me the slowest delivery times',
    'why is revenue down this month',
    'which customers explain most of our revenue',
    'which product has the best margin',
  ];
  for (const q of DATA) {
    it(`data: "${q}"`, () => {
      expect(isSchemaAdviceQuestion(q)).toBe(false);
      expect(isWriteRequest(q)).toBe(false);
    });
  }
});

describe('each predicate needs both of its halves', () => {
  it('an advice verb with no schema object is not advice', () => {
    expect(isSchemaAdviceQuestion('how can I improve my sales')).toBe(false);
  });

  it('a schema object with no advice verb is not advice', () => {
    expect(isSchemaAdviceQuestion('how many columns does orders have')).toBe(false);
  });

  it('a write verb with no request to be handed a statement is not a write request', () => {
    expect(isWriteRequest('orders can be deleted by an admin')).toBe(false);
  });

  it('asking for a query with no write verb is not a write request', () => {
    expect(isWriteRequest('write a query that counts orders')).toBe(false);
  });
});

describe('the IMPOSSIBLE sentinel never travels with the query it hedged', () => {
  it('strips a leading sentinel line from the explanation', () => {
    const reply = [
      'IMPOSSIBLE: The provided schema does not include a client_transactions table.',
      '',
      '```sql',
      'SELECT table_name FROM information_schema.tables',
      '```',
    ].join('\n');
    const extraction = extractSql(reply);
    expect(extraction?.sql).toContain('SELECT table_name');
    expect(extraction?.explanation).not.toMatch(/IMPOSSIBLE/i);
  });

  it('strips the sentinel word used mid-sentence', () => {
    const reply = 'This is IMPOSSIBLE: no such column exists.\n```sql\nSELECT 1 FROM orders\n```';
    expect(extractSql(reply)?.explanation).not.toMatch(/IMPOSSIBLE/i);
  });

  it('leaves an ordinary description untouched', () => {
    const reply = 'Counts the orders per customer.\n```sql\nSELECT customer_id, count(*) FROM orders GROUP BY 1\n```';
    expect(extractSql(reply)?.explanation).toBe('Counts the orders per customer.');
  });
});

describe('a follow-up knows which query it is about', () => {
  it('carries the prior turns into the prose prompt', () => {
    const prompt = buildSchemaAnswerUser('explain this query to me', 'TABLE orders', undefined, [
      { question: 'how many orders per status', sql: 'SELECT status, count(*) FROM orders GROUP BY status' },
    ]);
    expect(prompt).toContain('SELECT status, count(*) FROM orders GROUP BY status');
    expect(prompt).toContain('how many orders per status');
    expect(prompt).toContain('explain this query to me');
  });

  it('keeps only the last four turns', () => {
    const context = Array.from({ length: 8 }, (_, i) => ({ question: `q${i}`, sql: `SELECT ${i}` }));
    const prompt = buildSchemaAnswerUser('and that one?', 'TABLE orders', undefined, context);
    expect(prompt).not.toContain('SELECT 3');
    expect(prompt).toContain('SELECT 7');
  });

  it('is unchanged when there are no prior turns', () => {
    const prompt = buildSchemaAnswerUser('what is this database for', 'TABLE orders');
    expect(prompt).not.toContain('Conversation so far');
  });
});
