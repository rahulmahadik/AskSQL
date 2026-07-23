/**
 * Field inference over fixture documents - no server needed. inferColumns is
 * the pure mapper; introspectMongo runs against a fake DbLike to cover
 * collection listing, sampling failures and row estimates.
 */

import { describe, expect, it } from 'vitest';
import type { CollectionLike, DbLike } from '../src/driver.js';
import { inferColumns, introspectMongo } from '../src/introspect.js';

function fakeObjectId(hex: string): Record<string, unknown> {
  return { _bsontype: 'ObjectId', toHexString: () => hex };
}

describe('inferColumns', () => {
  it('walks nested objects into dotted paths and reports presence per document', () => {
    const docs = [
      { _id: fakeObjectId('aa11'), user: { name: 'ada', address: { city: 'NYC' } } },
      { _id: fakeObjectId('bb22'), user: { name: 'bob' } },
    ];
    const cols = inferColumns(docs, false);
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(cols[0]!.name).toBe('_id'); // _id surfaces first
    expect(byName.get('_id')!.dbType).toBe('objectId');
    expect(byName.get('user')!.dbType).toBe('object');
    expect(byName.get('user.name')).toMatchObject({ dbType: 'string', nullable: false });
    expect(byName.get('user.name')!.comment).toBe('present in 100% of 2 sampled documents');
    expect(byName.get('user.address.city')).toMatchObject({ dbType: 'string', nullable: true });
    expect(byName.get('user.address.city')!.comment).toBe('present in 50% of 2 sampled documents');
  });

  it('merges mixed types into a sorted mixed(...) type', () => {
    const cols = inferColumns([{ v: 1 }, { v: 'x' }], false);
    expect(cols[0]).toMatchObject({ name: 'v', dbType: 'mixed(int|string)' });
  });

  it('types arrays by first element and descends into arrays of objects', () => {
    const cols = inferColumns([{ tags: ['a', 'b'], items: [{ sku: 1 }, { sku: 2 }], none: [] }], false);
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get('tags')!.dbType).toBe('array<string>');
    expect(byName.get('items')!.dbType).toBe('array<object>');
    expect(byName.get('none')!.dbType).toBe('array');
    // Two array elements share the field, but presence counts documents.
    expect(byName.get('items.sku')!.comment).toBe('present in 100% of 1 sampled documents');
  });

  it('treats an explicit null as nullable while keeping the observed type', () => {
    const cols = inferColumns([{ v: null }, { v: 7 }], false);
    expect(cols[0]).toMatchObject({ dbType: 'int', nullable: true });
  });

  it('stops walking below the depth cap', () => {
    const cols = inferColumns([{ a: { b: { c: { d: { e: 1 } } } } }], false);
    const names = cols.map((c) => c.name);
    expect(names).toContain('a.b.c.d');
    expect(names).not.toContain('a.b.c.d.e');
  });

  it('collects sampledValues only when opted in', () => {
    const docs = [{ status: 'open' }, { status: 'closed' }, { status: 'open' }];
    const on = inferColumns(docs, true);
    expect([...on[0]!.sampledValues!].sort()).toEqual(['closed', 'open']);
    const off = inferColumns(docs, false);
    expect(off[0]!.sampledValues).toBeUndefined();
  });

  it('suppresses sampledValues past the 20-distinct-value cap', () => {
    const under = inferColumns(
      Array.from({ length: 20 }, (_, i) => ({ code: `c${i}` })),
      true,
    );
    expect(under[0]!.sampledValues).toHaveLength(20);

    const over = inferColumns(
      Array.from({ length: 21 }, (_, i) => ({ code: `c${i}` })),
      true,
    );
    expect(over[0]!.sampledValues).toBeUndefined();
    // Suppression does not affect presence accounting.
    expect(over[0]!.comment).toBe('present in 100% of 21 sampled documents');
  });
});

interface FakeCollection {
  docs?: Record<string, unknown>[];
  count?: number;
  sampleError?: Error;
  countError?: Error;
}

function fakeDb(collections: Record<string, FakeCollection>): DbLike {
  return {
    async command() {
      return { ok: 1 };
    },
    listCollections() {
      return { toArray: async () => Object.keys(collections).map((name) => ({ name })) };
    },
    collection(name: string): CollectionLike {
      const c = collections[name]!;
      return {
        aggregate() {
          return {
            toArray: async () => {
              if (c.sampleError) throw c.sampleError;
              return c.docs ?? [];
            },
            hasNext: async () => false,
            next: async () => null,
            close: async () => {},
          };
        },
        async estimatedDocumentCount() {
          if (c.countError) throw c.countError;
          return c.count ?? 0;
        },
      };
    },
  };
}

describe('introspectMongo', () => {
  it('samples every non-system collection into a table with an _id primary key', async () => {
    const db = fakeDb({
      users: { docs: [{ name: 'ada' }], count: 12 },
      'system.views': { docs: [{ hidden: true }] },
    });
    const catalog = await introspectMongo(db, { database: 'appdb', sampleColumnValues: false });
    expect(catalog.engine).toBe('mongodb');
    expect(catalog.schemas).toEqual(['appdb']);
    expect(catalog.tables.map((t) => t.name)).toEqual(['users']);
    expect(catalog.tables[0]!).toMatchObject({ primaryKey: ['_id'], rowEstimate: 12 });
    expect(catalog.tables[0]!.columns.map((c) => c.name)).toEqual(['name']);
  });

  it('keeps an empty collection as a table with an explanatory comment', async () => {
    const db = fakeDb({ empty: { docs: [], countError: new Error('nope') } });
    const catalog = await introspectMongo(db, { database: 'appdb', sampleColumnValues: false });
    expect(catalog.tables[0]!).toMatchObject({
      columns: [],
      rowEstimate: null,
      comment: 'empty or inaccessible - schema could not be sampled',
    });
  });

  it('turns a sampling failure into a warning, not a thrown error', async () => {
    const db = fakeDb({
      locked: { sampleError: new Error('not authorized on appdb'), count: 3 },
      open: { docs: [{ a: 1 }] },
    });
    const catalog = await introspectMongo(db, { database: 'appdb', sampleColumnValues: false });
    expect(catalog.tables).toHaveLength(2);
    expect(catalog.warnings.some((w) => w.includes("'locked'") && w.includes('not authorized'))).toBe(true);
  });
});
