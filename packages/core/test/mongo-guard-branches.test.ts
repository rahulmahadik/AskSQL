/**
 * MongoDB pipeline guard + extraction branch coverage: limit decisions, denied
 * operators, ReDoS/oversized regex, malformed stages, sub-pipeline recursion,
 * and pipeline extraction from prose/fences.
 */
import { describe, expect, it } from 'vitest';
import { guardPipeline, parsePipeline, extractPipeline } from '../src/mongo/index.js';

const g = (p: unknown) => guardPipeline(JSON.stringify(p));

describe('guardPipeline limit decisions', () => {
  it('auto-limits a pipeline with no $limit', () => {
    const v = g([{ $match: {} }]);
    expect(v.allowed).toBe(true);
    expect(v.autoLimited).toBe(true);
  });
  it('leaves an in-range $limit alone', () => {
    const v = g([{ $limit: 5 }]);
    expect(v.allowed).toBe(true);
    expect(v.autoLimited).toBe(false);
    expect(v.loweredLimit).toBe(false);
  });
  it('lowers an over-large trailing $limit', () => {
    const v = g([{ $match: {} }, { $limit: 10_000_000 }]);
    expect(v.allowed).toBe(true);
    expect(v.loweredLimit).toBe(true);
  });
});

describe('guardPipeline rejections', () => {
  it('rejects non-JSON and a non-array', () => {
    expect(guardPipeline('not json').allowed).toBe(false);
    expect(guardPipeline('{"$match":{}}').allowed).toBe(false);
    expect(parsePipeline('nope')).toBeNull();
    expect(parsePipeline('{"a":1}')).toBeNull();
  });
  it('rejects a JS-executing operator at any depth', () => {
    expect(g([{ $match: { $where: 'this.x==1' } }]).allowed).toBe(false);
    expect(g([{ $match: { $expr: { $and: [{ $function: { body: 'f', args: [], lang: 'js' } }] } } }]).allowed).toBe(
      false,
    );
  });
  it('rejects a catastrophic-backtracking regex', () => {
    expect(g([{ $match: { x: { $regex: '(a+)+$' } } }]).allowed).toBe(false);
  });
  it('rejects a non-object stage and a multi-key stage', () => {
    expect(g([[1, 2]]).allowed).toBe(false);
    expect(g([{ $match: {}, $limit: 1 }]).allowed).toBe(false);
  });
  it('rejects a write stage hidden in a $lookup sub-pipeline (recursion)', () => {
    expect(g([{ $lookup: { from: 'x', as: 'j', pipeline: [{ $merge: { into: 's' } }] } }]).allowed).toBe(false);
  });
  it('collects referenced collections from $lookup / $unionWith', () => {
    const v = guardPipeline(JSON.stringify([{ $lookup: { from: 'other', as: 'j' } }, { $unionWith: 'more' }]));
    expect(v.allowed).toBe(true);
    expect(v.collections).toEqual(expect.arrayContaining(['other', 'more']));
  });
});

describe('extractPipeline', () => {
  it('extracts a collection + pipeline from a js fence', () => {
    const ex = extractPipeline('```js\ndb.orders.aggregate([{"$match": {"status": "paid"}}])\n```\nPaid orders.');
    expect(ex).toBeTruthy();
    expect(ex!.collection).toBe('orders');
    expect(JSON.parse(ex!.pipelineJson)).toEqual([{ $match: { status: 'paid' } }]);
  });
  it('returns null for prose with no pipeline', () => {
    expect(extractPipeline('I cannot answer that.')).toBeNull();
  });
});
