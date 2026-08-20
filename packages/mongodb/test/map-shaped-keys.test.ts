/**
 * A document may use a map where the KEYS are data: `{ owed: { "ada@example.com": 120 } }`. Walked
 * naively every address becomes a column name, and a column name is never removed by the data opt-in -
 * `withoutSampledData` strips sampled values only. So those addresses reached the prompt on the default
 * path, against PRIVACY.md's promise that the model never receives row data.
 *
 * A record repeats its fields across documents; a map does not. That is the whole test.
 */
import { describe, expect, it } from 'vitest';
import { inferColumns } from '../src/introspect.js';

const names = (docs: Record<string, unknown>[]) => inferColumns(docs, false).map((c) => c.name);
const commentFor = (docs: Record<string, unknown>[], path: string) =>
  inferColumns(docs, false).find((c) => c.name === path)?.comment ?? '';

describe('a map whose keys are data is described, never enumerated', () => {
  const ledger = [
    { ref: 'a', owed: { 'ada@example.com': 120, 'bob@corp.com': 40 } },
    { ref: 'b', owed: { 'grace@example.com': 80 } },
    { ref: 'c', owed: { 'linus@example.com': 5 } },
  ];

  it('never turns an address into a column name', () => {
    const cols = names(ledger);
    expect(cols).toContain('owed');
    for (const who of ['ada', 'bob', 'grace', 'linus']) {
      expect(cols.join(' '), who).not.toContain(who);
    }
  });

  it('says what the shape is instead', () => {
    const comment = commentFor(ledger, 'owed');
    expect(comment).toMatch(/map-shaped/);
    expect(comment).toMatch(/\$objectToArray/);
    expect(comment).not.toMatch(/@/); // the shape, never a key
  });

  it('resolves the parent even when the keys contain dots', () => {
    // The regression that hid this: splitting a path on its last dot lands inside "example.com",
    // yielding a parent that does not exist, so the check skipped exactly the shape it was for.
    const cols = names(ledger);
    expect(cols.filter((c) => c.startsWith('owed.'))).toHaveLength(0);
  });

  it('collapses a map keyed by ids, which look nothing like addresses', () => {
    const docs = [
      { basket: { sku_10012: 2, sku_88211: 1 } },
      { basket: { sku_40391: 5 } },
      { basket: { sku_77123: 9 } },
    ];
    expect(names(docs).filter((c) => c.startsWith('basket.'))).toHaveLength(0);
    expect(commentFor(docs, 'basket')).toMatch(/map-shaped/);
  });
});

describe('one field beside the keys does not shield them', () => {
  // The judgement is per child. Judged per parent, a single summary field sitting beside the map
  // vetoed the collapse and every address stayed a column name.
  it('drops the keys and keeps the summary field', () => {
    const docs = Array.from({ length: 50 }, (_, i) => ({
      owed: { total: 100, [`user${i}@example.com`]: 5 },
    }));
    const cols = names(docs);
    expect(cols).toContain('owed.total');
    expect(cols.join(' ')).not.toContain('@example.com');
  });

  it('drops the keys when one of them is itself a recurring address', () => {
    const docs = Array.from({ length: 4 }, (_, i) => ({
      perms: { 'admin@corp.com': 'rw', [`ada${i}@example.com`]: 'r' },
    }));
    expect(names(docs).join(' ')).not.toContain('@');
  });

  it('drops keys seen in only one sampled document', () => {
    const docs = [
      ...Array.from({ length: 19 }, () => ({ ref: 'x' })),
      { owed: { 'ada@example.com': 120, 'grace@example.com': 80 } },
    ];
    expect(names(docs).join(' ')).not.toContain('@');
  });

  it('drops keys inside an array element, where the parent is not typed object', () => {
    const docs = Array.from({ length: 50 }, (_, i) => ({ payouts: [{ [`user${i}@example.com`]: 1 }] }));
    expect(names(docs).join(' ')).not.toContain('@');
  });
});

describe('a map whose keys recur is still a map', () => {
  // Judging recurrence by a pooled average only asks whether names average two documents each, which
  // any large map satisfies, and recurrence rises with the sample size.
  it('drops thirty slugs seen repeatedly across a hundred documents', () => {
    const docs = Array.from({ length: 100 }, (_, i) => ({ usage: { [`ZZT${i % 30}`]: i } }));
    expect(names(docs).filter((c) => c.startsWith('usage.'))).toHaveLength(0);
  });

  it('drops a hundred field-shaped usernames, which no shape test can reject', () => {
    // user_0 passes FIELD_SEGMENT exactly as a real field would; only cardinality tells them apart.
    const docs = Array.from({ length: 200 }, (_, i) => ({ reactions: { [`user_${i % 100}`]: 'like' } }));
    expect(names(docs).filter((c) => c.startsWith('reactions.'))).toHaveLength(0);
  });

  it('keeps a record whose every field recurs', () => {
    const docs = Array.from({ length: 10 }, () => ({ address: { city: 'C', zip: '1', street: 'S' } }));
    for (const f of ['address.city', 'address.zip', 'address.street']) expect(names(docs), f).toContain(f);
  });
});

describe('a polymorphic record is not mistaken for a map', () => {
  it('keeps mutually exclusive fields that no single document shares', () => {
    // Payment details differ by method, so no child reaches 60% of the parent's documents - but the
    // names saturate, a few reused across many documents, which a map's keys never do.
    const docs = [
      ...Array.from({ length: 40 }, () => ({ payment: { card_last4: '1234', card_brand: 'visa' } })),
      ...Array.from({ length: 35 }, () => ({ payment: { paypal_email: 'x' } })),
      ...Array.from({ length: 25 }, () => ({ payment: { bank_ref: 'r' } })),
    ];
    const cols = names(docs);
    for (const field of ['payment.card_last4', 'payment.card_brand', 'payment.paypal_email', 'payment.bank_ref']) {
      expect(cols, field).toContain(field);
    }
  });
});

describe('a document that is a map at its root', () => {
  // These paths have no parent, so a rule judging only parent/child pairs never examined them and every
  // address stayed a top-level column name.
  it('never turns a root-level key into a column name', () => {
    const docs = Array.from({ length: 6 }, (_, i) => ({ [`user${i}@example.com`]: i, ref: 'x' }));
    const cols = names(docs);
    expect(cols).toContain('ref');
    expect(cols.join(' ')).not.toContain('@');
  });

  it('leaves an ordinary document untouched', () => {
    const docs = Array.from({ length: 6 }, (_, i) => ({ _id: i, ref: 'x', address: { city: 'C', zip: '1' } }));
    const cols = names(docs);
    for (const f of ['_id', 'ref', 'address', 'address.city', 'address.zip']) expect(cols, f).toContain(f);
  });
});

describe('a key containing dots is still a key', () => {
  // A path cannot be split back into parent and child by text: the key "db.internal" has a first
  // segment that is also a real field, so the split stole it and only the field-shaped tail was judged.
  it('drops a dotted key whose prefix collides with a real field', () => {
    const docs = [
      ...Array.from({ length: 5 }, () => ({ latency: { db: 1 } })),
      ...Array.from({ length: 5 }, () => ({ latency: { 'db.internal': 5 } })),
    ];
    const cols = names(docs);
    expect(cols).toContain('latency.db');
    expect(cols).not.toContain('latency.db.internal');
  });

  it('drops a dotted address key beside a real summary field', () => {
    const docs = [
      ...Array.from({ length: 5 }, () => ({ owed: { total: 1 } })),
      ...Array.from({ length: 5 }, (_, i) => ({ owed: { [`total.user${i}@example.com`]: 5 } })),
    ];
    const cols = names(docs);
    expect(cols).toContain('owed.total');
    expect(cols.join(' ')).not.toContain('@');
  });
});

describe('the root is judged by shape alone', () => {
  // One document per integration is an ordinary collection, and its field names do not recur. Judging
  // the root by reuse returned a catalog of just `_id` and deleted all eight real names.
  it('keeps every field of a heterogeneous collection', () => {
    const docs = [
      { _id: 1, slack_webhook: 'a', slack_channel: 'b' },
      { _id: 2, github_token: 'c', github_repo: 'd' },
      { _id: 3, jira_url: 'e', jira_project: 'f' },
      { _id: 4, pager_key: 'g', pager_team: 'h' },
    ];
    expect(names(docs)).toHaveLength(9);
  });

  it('still drops a root keyed by addresses', () => {
    const docs = Array.from({ length: 6 }, (_, i) => ({ [`user${i}@example.com`]: i, ref: 'x' }));
    expect(names(docs).join(' ')).not.toContain('@');
  });

  it('keeps a field name that is not ASCII', () => {
    const docs = Array.from({ length: 40 }, (_, i) => ({ id: i, profile: { 名前: `n${i}`, age: i } }));
    expect(names(docs)).toContain('profile.名前');
  });
});

describe('a real record keeps every field it has', () => {
  const people = [
    { address: { city: 'Pune', zip: '411001' }, name: 'Ada' },
    { address: { city: 'Berlin', zip: '10115' }, name: 'Grace' },
    { address: { city: 'Oslo' }, name: 'Linus' },
  ];

  it('keeps fields that recur across documents', () => {
    const cols = names(people);
    expect(cols).toContain('address.city');
    expect(cols).toContain('address.zip'); // present in two of three, still part of the shape
  });

  it('leaves the parent comment as an ordinary presence note', () => {
    expect(commentFor(people, 'address')).toMatch(/present in 100% of 3 sampled documents/);
  });

  it('keeps a record and collapses a map living side by side', () => {
    const docs = people.map((p, i) => ({
      ...p,
      owed: { [`user${i}@example.com`]: i, [`other${i}@example.com`]: i },
    }));
    const cols = names(docs);
    expect(cols).toContain('address.city');
    expect(cols.join(' ')).not.toContain('@example.com');
  });
});

describe('a small sample still keeps real field names', () => {
  // With one document a record and a map are identical by reuse. Judging on that evidence deleted the
  // fields of every sub-document in a small sample; the key's shape still decides.
  it('keeps a sub-document sampled from a single document', () => {
    const cols = names([{ address: { city: 'NYC', zip: '10001' } }]);
    expect(cols).toContain('address.city');
    expect(cols).toContain('address.zip');
  });

  it('still drops keys that cannot be field names, however small the sample', () => {
    const cols = names([{ owed: { 'ada@example.com': 120, 'grace@example.com': 80 } }]);
    expect(cols.join(' ')).not.toContain('@');
  });
});

describe('the rule stays conservative when there is no evidence either way', () => {
  it('does not collapse a parent with a single child', () => {
    // One child cannot show whether keys recur; collapsing here would lose a real field name.
    const docs = [{ meta: { version: 1 } }, { meta: { version: 2 } }, { meta: { version: 3 } }];
    expect(names(docs)).toContain('meta.version');
  });

  it('does not collapse when one child recurs and the rest do not', () => {
    const docs = [
      { cfg: { mode: 'a', tmp_x: 1 } },
      { cfg: { mode: 'b', tmp_y: 2 } },
      { cfg: { mode: 'c', tmp_z: 3 } },
    ];
    expect(names(docs)).toContain('cfg.mode');
  });
});
