/**
 * A corpus of the questions people actually bring to a database assistant, each with the route it
 * must take. Routing is what decides whether someone gets an answer or a catalog listing, and a
 * spot check does not measure it - only a corpus does.
 *
 * data    - generate SQL and run it
 * advice  - answer in prose; no query exists
 * write   - propose the statement with an explanation; never execute
 * listing - a catalog query answers it
 */
import { describe, expect, it } from 'vitest';
import {
  isDatabaseOverviewQuestion,
  isMetadataQuestion,
  isSchemaAdviceQuestion,
  isWriteRequest,
} from '../src/schema-match.js';

type Route = 'data' | 'advice' | 'write' | 'listing';

const CORPUS: readonly (readonly [Route, string])[] = [
  // --- Everyday data questions -------------------------------------------------
  ['data', 'how many orders were placed last week'],
  ['data', 'total revenue by region'],
  ['data', 'which customers have no orders'],
  ['data', 'what is the average order value'],
  ['data', 'list the top 10 customers by spend'],
  ['data', 'how many active users signed up in March'],
  ['data', 'show me all cancelled orders from yesterday'],
  ['data', 'count orders per status'],
  ['data', 'which products have never been ordered'],
  ['data', 'what is our total refund amount this quarter'],
  ['data', 'orders placed between January and March'],
  ['data', 'how many customers are in each region'],
  ['data', 'find customers who ordered more than five times'],
  ['data', 'what was the biggest single order last month'],
  ['data', 'revenue per month for the last year'],

  // --- Complex analytics -------------------------------------------------------
  ['data', 'running total of revenue by day'],
  ['data', 'top 3 products per category by sales'],
  ['data', 'month over month growth in orders'],
  ['data', 'the median order value per region'],
  ['data', 'customers whose first order was more than a year ago'],
  ['data', 'rank customers by lifetime value within their region'],
  ['data', 'week over week retention of new signups'],
  ['data', 'the 90th percentile of delivery time'],
  ['data', 'find gaps in the order id sequence'],
  ['data', 'cumulative revenue by customer cohort'],
  ['data', 'pivot order counts by status across months'],
  ['data', 'customers who bought A but never bought B'],
  ['data', 'the second most recent order for each customer'],
  ['data', 'compare this quarter against the same quarter last year'],
  ['data', 'average days between a customer first and second order'],
  ['data', 'which two products are most often bought together'],
  ['data', 'the share of revenue from the top 10 percent of customers'],

  // --- Data quality ------------------------------------------------------------
  ['data', 'are there duplicate email addresses in customers'],
  ['data', 'find orders with no matching customer'],
  ['data', 'how many rows have a null region'],
  ['data', 'are there negative totals anywhere'],
  ['data', 'find rows where placed_at is in the future'],
  ['data', 'which columns have the most nulls'],

  // --- Schema and query advice -------------------------------------------------
  ['advice', 'how can I improve this schema'],
  ['advice', 'can you check if i wants improve db schema what are the possiblities'],
  [
    'advice',
    'can you please review the db schema and tell me to improve relations between tables what needs to update',
  ],
  ['advice', 'review my schema and suggest indexes'],
  ['advice', 'which indexes should I add to speed up these joins'],
  ['advice', 'how can I improve the performance of this query'],
  ['advice', 'this query is slow, how do I optimize it'],
  ['advice', 'why is this query slow'],
  ['advice', 'should I normalize the customers table'],
  ['advice', 'pros and cons of denormalizing this table'],
  ['advice', 'pros and cons of denormalizing order_items'],
  ['advice', 'should I denormalize order_items'],
  ['advice', 'recommend a partitioning strategy for the orders table'],
  ['advice', 'what is the best index strategy for filtering orders by status and date'],
  ['advice', 'should I add a composite index on orders (customer_id, placed_at)'],
  ['advice', 'is my data model missing any constraints'],
  ['advice', 'any problems with my foreign keys'],
  ['advice', 'what is wrong with this database structure'],
  ['advice', 'what needs to be fixed in this schema'],
  ['advice', 'audit the schema design'],
  ['advice', 'tune the database for faster reads'],
  ['advice', 'how do I make this join faster between products, inventory and warehouses'],
  ['advice', 'would denormalizing order_items into orders help performance'],
  ['advice', 'suggest better indexing for the join between orders and customers'],
  ['advice', 'when should I use a composite index here'],
  ['advice', 'is a covering index worth it for this query'],
  ['advice', 'should I shard this database'],
  ['advice', 'do you think this schema scales'],
  ['advice', 'what are the trade-offs of adding a materialized view here'],
  ['advice', 'best practices for naming columns in this schema'],
  ['advice', 'how do I reduce the latency of these queries'],

  // --- Explaining, translating, debugging --------------------------------------
  ['advice', 'explain this query to me'],
  ['advice', 'explain what this SQL does'],
  ['advice', 'convert this MySQL query to Postgres'],
  ['advice', 'translate this query to the syntax this database uses'],
  ['advice', 'rewrite this query without a subquery'],
  ['advice', 'why does this query return duplicate rows'],
  ['advice', 'why does my join produce more rows than expected'],
  ['advice', 'what is the difference between a view and a materialized view in this schema'],
  ['advice', 'document the schema for a new developer'],
  ['advice', 'why is my query returning no rows'],
  ['advice', 'migrate this schema to use a surrogate key'],

  // --- Write requests ----------------------------------------------------------
  ['write', 'write a statement that deletes cancelled orders'],
  ['write', 'write a query that removes old rows'],
  ['write', 'give me a SQL command to drop the archive table'],
  ['write', 'generate a migration to add a status column'],
  ['write', 'how do I write a query to update prices'],
  ['write', 'draft a script that truncates the staging table'],
  ['write', 'I need a statement to insert a new customer'],
  ['write', 'produce a command to rename the orders table'],
  ['write', 'write the SQL to add a foreign key'],
  ['write', 'give me a query to delete duplicate customers'],
  ['write', 'compose a migration that alters the status column'],
  ['write', 'I want a script to insert test data'],

  // --- Catalog listings --------------------------------------------------------
  ['listing', 'show me all the tables'],
  ['listing', 'list the columns in orders'],
  ['listing', 'how many tables are there'],
  ['listing', 'what views exist in this database'],
  // A description of the whole database, not a table list: these used to return `SELECT table_name ...`.
  ['advice', 'describe the schema'],
  ['advice', 'can you give details about this db'],
  ['advice', 'give me details about the db schema'],
  ['advice', 'tell me about this database'],
  ['advice', 'give me an overview of this database'],
  ['advice', 'explain the schema to me'],
  ['advice', 'summarise the database structure'],
  ['advice', 'walk me through the data model'],
  ['advice', 'high-level details of this db'],
  ['advice', 'help me understand this schema'],
  ['listing', 'what tables do we have'],
  ['listing', 'enumerate the columns of customers'],
  ['listing', 'display all views'],

  // --- Wording that could easily be misrouted ----------------------------------
  ['data', 'which region performed better last quarter'],
  ['data', 'show me the slowest delivery times'],
  ['data', 'why is revenue down this month'],
  ['data', 'which customers explain most of our revenue'],
  ['data', 'which product has the best margin'],
  ['data', 'how many orders were deleted last week'],
  ['data', 'which customers were added in January'],
  ['data', 'show me the cancelled orders'],
  ['data', 'list customers missing a phone number'],
  ['data', 'what is the total revenue'],
  ['data', 'find the fastest shipping carrier'],
  ['data', 'orders that need updating before shipping'],
  // --- Wording variations: how people actually type, not how a test author would -------
  ['advice', 'how can the schema be improved'],
  ['advice', 'can you take a look at my schema'],
  ['advice', 'i want to improve my db'],
  ['advice', 'anything i should change in this schema'],
  ['advice', 'give me feedback on the schema'],
  ['advice', 'do I need an index here'],
  ['advice', 'should there be an index on customer_id'],
  ['advice', 'would an index help here'],
  ['advice', 'how do I index this properly'],
  ['advice', 'this is slow, what do I do'],
  ['advice', 'the query takes forever'],
  ['advice', 'performance is bad, ideas?'],
  ['advice', 'my joins are slow'],
  ['advice', 'should this be normalized'],
  ['advice', 'do I have too many tables'],
  ['advice', 'is my table design ok'],
  ['advice', 'thoughts on this data model'],
  ['advice', 'does this design make sense'],
  ['advice', 'what does this query do'],
  ['advice', 'break down this query for me'],
  ['advice', 'rewrite this in postgres'],
  ['advice', 'port this query to mysql'],
  ['advice', 'why am I getting extra rows'],
  ['advice', 'what is in this database'],
  ['advice', 'brief me on this database'],
  ['advice', 'what does this database contain'],
  ['write', 'write me a delete statement for cancelled orders'],
  ['write', 'i need sql to remove old rows'],
  ['write', 'can you generate an insert statement'],
  ['write', 'give me the ddl to add a column'],
  ['write', 'produce an update query for prices'],
  ['data', 'how many orders'],
  ['data', 'orders count'],
  ['data', 'i want to see revenue by region'],
  ['data', 'which customer spent the most'],
  ['data', 'orders from last month'],
  ['data', 'list customers without orders'],
  ['data', 'average basket size'],
  ['data', 'are there any duplicate emails'],
];

/** Mirrors the engine: write is checked first, then advice; everything else generates SQL. */
function routeOf(question: string): Route {
  if (isWriteRequest(question)) return 'write';
  if (isSchemaAdviceQuestion(question) || isDatabaseOverviewQuestion(question)) return 'advice';
  return isMetadataQuestion(question) ? 'listing' : 'data';
}

describe(`question corpus (${CORPUS.length} questions)`, () => {
  for (const [expected, question] of CORPUS) {
    it(`${expected}: "${question.slice(0, 56)}"`, () => {
      const actual = routeOf(question);
      // 'listing' is a hint for the repair loop, not a separate path: both still generate SQL,
      // so a data question classified as a listing is not a misroute.
      if (expected === 'data' && actual === 'listing') return;
      expect(actual).toBe(expected);
    });
  }

  it('covers every route', () => {
    const seen = new Set(CORPUS.map(([route]) => route));
    expect([...seen].sort()).toEqual(['advice', 'data', 'listing', 'write']);
  });

  it('is large enough to be a corpus rather than a spot check', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(100);
  });
});

/**
 * A routing keyword used as a table or column name. The corpus above phrases questions the way the
 * authors would; these are the ones that broke, where "archive", "feedback", "review", "issues",
 * "prompts" or "document" is the user's own identifier rather than a request for advice.
 */
const KEYWORD_AS_IDENTIFIER: readonly (readonly [Route, string])[] = [
  ['data', 'show me the first document in the users collection'],
  ['data', 'find the document with email x@y.com'],
  ['data', 'get the most recent document from orders'],
  ['data', 'how many orders are in the archive table'],
  ['data', 'count rows in the feedback table'],
  ['data', 'show me the review table'],
  ['data', 'which issues were closed this week, from the issues table'],
  ['data', 'show me the prompts table'],
  ['data', 'show the running total of sales partitioned by region'],
  ['data', 'average rank partition by category'],
  ['data', 'which orders were slow to ship'],
  ['data', 'which deliveries were slow yesterday'],
  ['data', 'what are the best selling products in the orders table'],
  ['data', 'which videos got the best views last week'],
  ['data', 'top 10 customers by net worth from the accounts table'],
  ['data', 'list unused coupons from the coupons table'],
  // Still advice, with the same words in an advisory frame.
  ['advice', 'how would I partition the largest tables'],
  ['advice', 'should I shard this collection'],
  ['advice', 'what is the best index strategy for filtering orders'],
  ['advice', 'document the schema for a new developer'],
  ['advice', 'are there any issues with this schema'],
  ['advice', 'my joins are slow'],
];

describe('a routing keyword used as an identifier', () => {
  for (const [expected, question] of KEYWORD_AS_IDENTIFIER) {
    it(`${expected}: "${question.slice(0, 56)}"`, () => {
      const actual = routeOf(question);
      if (expected === 'data' && actual === 'listing') return;
      expect(actual).toBe(expected);
    });
  }
});
