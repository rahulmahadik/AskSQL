/**
 * Edge cases in the scope guard and the grounding floor. These predicates decide whether a real
 * answer reaches the user, so a false positive replaces a correct answer with a decline.
 */
import { describe, expect, it } from 'vitest';
import { isDegenerateAnswer, isOffTopic, isProseRefusal, stripSentinel } from '../src/scope.js';
import { SCHEMA_CHANGE_RE, mentionsCatalogName, unknownReferencesInProse } from '../src/grounding.js';
import type { SchemaCatalog, TableInfo } from '../src/types.js';

function tbl(name: string, cols: string[], schema?: string): TableInfo {
  return {
    name,
    schema,
    kind: 'table',
    columns: cols.map((c) => ({ name: c, dbType: 'text', nullable: true })),
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    checks: [],
    indexes: [],
    source: 'db',
  };
}
const CATALOG: SchemaCatalog = {
  engine: 'postgres',
  schemas: ['shop'],
  tables: [tbl('orders', ['id', 'customer_id', 'status'], 'shop'), tbl('customers', ['id', 'name'], 'shop')],
  enums: [],
  sequences: [],
  triggers: [],
  routines: [],
  warnings: [],
  fetchedAt: 'now',
};

describe('the off-topic sentinel is distinguishable from English prose', () => {
  it('treats the punctuated marker as the sentinel, in any case', () => {
    expect(isOffTopic('OUT_OF_SCOPE')).toBe(true);
    expect(isOffTopic('out-of-scope')).toBe(true);
    expect(isOffTopic('**OUT_OF_SCOPE**')).toBe(true);
  });

  it('treats the shouted spaced marker as the sentinel', () => {
    expect(isOffTopic('OUT OF SCOPE')).toBe(true);
  });

  // "out of scope" is ordinary English: an answer containing it was thrown away and replaced
  // by the decline.
  it('does not treat lower-case English "out of scope" as the sentinel', () => {
    expect(isOffTopic('Indexes are out of scope for this question, but shop.orders has one on id.')).toBe(false);
    expect(isOffTopic('That is out of scope here.')).toBe(false);
  });

  it('still strips a punctuated marker the model bolted onto a real answer', () => {
    expect(stripSentinel('OUT_OF_SCOPE shop.orders links to shop.customers')).toBe(
      'shop.orders links to shop.customers',
    );
  });

  it('leaves prose containing the English phrase untouched', () => {
    const prose = 'Partitioning is out of scope for this answer.';
    expect(stripSentinel(prose)).toBe(prose);
  });
});

describe('a short answer is judged as prose, whatever the script', () => {
  it('rejects a genuine fragment', () => {
    expect(isDegenerateAnswer('OUT_ARGUMENT VARCHAR2')).toBe(true);
    expect(isDegenerateAnswer('yes')).toBe(true);
  });

  // CJK writes no spaces, so a whole sentence counted as one word.
  it('keeps a complete Japanese sentence', () => {
    expect(isDegenerateAnswer('注文テーブルはcustomer_idで顧客テーブルに紐づきます')).toBe(false);
  });

  it('keeps a complete Russian sentence', () => {
    expect(isDegenerateAnswer('Таблица заказов связана с клиентами')).toBe(false);
  });

  it('still rejects a one-word CJK reply', () => {
    expect(isDegenerateAnswer('はい')).toBe(true);
  });
});

describe('a refusal is recognised however the apostrophe is typed', () => {
  it('matches the ASCII apostrophe', () => {
    expect(isProseRefusal("I'm sorry, but I can't help with that.")).toBe(true);
  });

  // Models emit U+2019 as often as U+0027; those refusals were shown as though they were answers.
  it('matches the typographic apostrophe', () => {
    expect(isProseRefusal('I’m sorry, but I can’t help with that.')).toBe(true);
  });

  it('still keeps a hedged answer that names real schema', () => {
    expect(isProseRefusal("I can't tell from the schema alone, but shop.orders has status.", true)).toBe(false);
  });
});

describe('"is this answer about this database" is not satisfied by everyday English', () => {
  it('recognises a real table, including a qualified reference', () => {
    expect(mentionsCatalogName('join shop.orders to shop.customers', CATALOG)).toBe(true);
    expect(mentionsCatalogName('the orders table', CATALOG)).toBe(true);
  });

  it('recognises a distinctive column', () => {
    expect(mentionsCatalogName('link them on customer_id', CATALOG)).toBe(true);
  });

  // With a `name` column in the catalog, almost any sentence matched and the deterministic
  // off-topic backstop stopped firing.
  it('is not satisfied by the everyday word behind a generic column name', () => {
    expect(mentionsCatalogName('My name is on the parcel, thanks for asking.', CATALOG)).toBe(false);
  });

  it('is not satisfied by a substring inside a longer word', () => {
    expect(mentionsCatalogName('You can rename things in a namespace.', CATALOG)).toBe(false);
  });
});

describe('the grounding floor is not disarmed by the English word "with"', () => {
  // A bare `with` counted as SQL context, so `... stored as customer_history` read as a column
  // alias and the invented name was whitelisted.
  it('flags an invented name introduced by a prose "as" after the word "with"', () => {
    const answer =
      'Along with shop.orders, historical activity is stored as customer_history and linked by customer_id.';
    expect(unknownReferencesInProse(answer, CATALOG)).toContain('customer_history');
  });

  it('still accepts a genuine SQL alias in a real statement', () => {
    const answer = 'Run: SELECT count(*) AS order_count FROM shop.orders';
    expect(unknownReferencesInProse(answer, CATALOG)).toEqual([]);
  });

  it('still accepts a real CTE name', () => {
    const answer = 'Use WITH recent_orders AS (SELECT * FROM shop.orders) SELECT * FROM recent_orders';
    expect(unknownReferencesInProse(answer, CATALOG)).toEqual([]);
  });
});

describe('backticks wrap more than identifiers', () => {
  it('does not report a bound-parameter placeholder as a missing name', () => {
    const answer = 'Bind the id as `?` and pass it yourself.';
    expect(unknownReferencesInProse(answer, CATALOG)).toEqual([]);
  });

  it('does not report a backticked literal or operator as a missing name', () => {
    for (const answer of ['Use `2024-01-01` as the cutoff.', 'Compare with `>=` on the date.', 'Pass `:customer_id`.']) {
      expect(unknownReferencesInProse(answer, CATALOG)).toEqual([]);
    }
  });

  it('still reports a backticked name that really is missing', () => {
    expect(unknownReferencesInProse('Add a `customer_history` table.', CATALOG)).toContain('customer_history');
  });

  it('still accepts a backticked qualified name that exists', () => {
    expect(unknownReferencesInProse('Read `shop.orders` for this.', CATALOG)).toEqual([]);
  });

  // Backticks are how MySQL quotes identifiers, and a hyphen is legal inside them.
  it('still reports a missing hyphenated name', () => {
    expect(unknownReferencesInProse('Check the `order-history` table.', CATALOG)).toContain('order-history');
  });
});

describe('SQL vocabulary in an answer is not an invented name', () => {
  // An answer that sets keywords in backticks - the normal way to write one - reported them as
  // invented names, costing a repair round-trip and marking it ungrounded.
  it('ignores backticked keywords and function calls', () => {
    const answer =
      'The `orders` table links to `customers` through customer_id. `JOIN` them and use `COUNT(*)` grouped by status.';
    expect(unknownReferencesInProse(answer, CATALOG)).toEqual([]);
  });

  it('still catches an invented table set in backticks', () => {
    expect(unknownReferencesInProse('Look in `customer_history` for that.', CATALOG)).toContain('customer_history');
  });
});

/**
 * A hand-maintained keyword list is only as good as its coverage, so this is a corpus rather
 * than a spot check: realistic explanation sentences of the kind the models actually produce.
 * Every one must come back with zero invented names.
 */
describe('SQL vocabulary corpus produces no false positives', () => {
  const CLEAN = [
    'Use `ROW_NUMBER()` over (partition by customer_id order by id) to pick the latest order.',
    'Group with date_trunc on a timestamp column, then order by the bucket.',
    'You can use string_agg or array_agg to collapse the rows into one value per customer.',
    'A LEFT JOIN keeps customers with no orders; use COALESCE to turn the null into 0.',
    'Add an index on shop.orders(customer_id) - see EXPLAIN for whether it is used.',
    'current_timestamp and now() both work; date_part can pull the month out.',
    'Use a CASE expression with NULLIF to avoid dividing by zero.',
    'The status column is text; CAST it if you need a number.',
    'Filter with WHERE ... IN (...) or an EXISTS subquery on shop.orders.',
    'generate_series can fill missing dates before the LEFT JOIN.',
    'Use `COUNT(*)` with `GROUP BY` and `HAVING` to keep only busy customers.',
    'An order_by on a computed alias works in Postgres.',
  ];

  for (const answer of CLEAN) {
    it(`treats SQL vocabulary as vocabulary: "${answer.slice(0, 46)}..."`, () => {
      expect(unknownReferencesInProse(answer, CATALOG)).toEqual([]);
    });
  }

  // The other half of the contract: the stoplist must not have swallowed the floor's real job.
  it('still catches invented names sitting among all that vocabulary', () => {
    const answer =
      'Use ROW_NUMBER() over (partition by customer_id) against customer_history, ' +
      'then LEFT JOIN order_archive to get the totals.';
    const found = unknownReferencesInProse(answer, CATALOG);
    expect(found).toContain('customer_history');
    expect(found).toContain('order_archive');
  });
});

describe('a change request is recognised however the verb is conjugated', () => {
  // Third-person phrasing is at least as common as the imperative, and without it the question
  // was not recognised as a change at all - the scope guard declined it instead of proposing.
  const CHANGES = [
    'Write a command that deletes cancelled orders',
    'a query that removes old rows',
    'something that creates an index on customer_id',
    'a script that updates prices',
    'give me a statement that drops the archive table',
    'How do I delete all cancelled orders',
  ];
  for (const q of CHANGES) {
    it(`treats as a change: "${q.slice(0, 40)}"`, () => {
      expect(SCHEMA_CHANGE_RE.test(q)).toBe(true);
    });
  }

  // Past tense describes data, not a change - keeping these out avoids skipping the grounding
  // floor for ordinary questions about when rows appeared.
  const QUESTIONS = [
    'how many orders were created last week',
    'show me the address book',
    'which rows were updated_at set on',
  ];
  for (const q of QUESTIONS) {
    it(`treats as a question: "${q.slice(0, 40)}"`, () => {
      expect(SCHEMA_CHANGE_RE.test(q)).toBe(false);
    });
  }
});
