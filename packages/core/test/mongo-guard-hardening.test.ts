/**
 * MongoDB guard hardening: regex heuristics reach every pattern carrier (H5),
 * the row cap bounds document size via facet limits and unbounded-accumulator
 * rejection (M2), and out-of-range bare integer literals are refused (M5).
 */
import { describe, expect, it } from 'vitest';
import { guardPipeline } from '../src/mongo/index.js';

const g = (p: unknown) => guardPipeline(JSON.stringify(p));
const REDOS = '(a+)+$';
const LONG = 'a'.repeat(201);

describe('H5 regex guard reaches every pattern carrier', () => {
  it('blocks an EJSON $regularExpression ReDoS pattern', () => {
    const v = g([{ $match: { x: { $regularExpression: { pattern: REDOS, options: '' } } } }]);
    expect(v.allowed).toBe(false);
    expect(v.ruleId).toBe('regex_unsafe');
  });
  it('blocks a ReDoS pattern nested in a $regex EJSON value', () => {
    const v = g([{ $match: { x: { $regex: { $regularExpression: { pattern: REDOS, options: 'i' } } } } }]);
    expect(v.allowed).toBe(false);
  });
  it('blocks $regexMatch / $regexFind / $regexFindAll carrying the pattern under `regex`', () => {
    for (const op of ['$regexMatch', '$regexFind', '$regexFindAll']) {
      const v = g([{ $project: { m: { [op]: { input: '$x', regex: REDOS } } } }]);
      expect(v.allowed).toBe(false);
      expect(v.ruleId).toBe('regex_unsafe');
    }
  });
  it('blocks an oversized pattern via $regularExpression', () => {
    const v = g([{ $match: { x: { $regularExpression: { pattern: LONG, options: '' } } } }]);
    expect(v.allowed).toBe(false);
    expect(v.ruleId).toBe('regex_too_long');
  });
  it('fails closed on an opaque (non-string, non-EJSON) $regex value', () => {
    expect(g([{ $match: { x: { $regex: 123 } } }]).ruleId).toBe('regex_opaque');
    expect(g([{ $match: { x: { $regularExpression: { pattern: 5 } } } }]).ruleId).toBe('regex_opaque');
  });
  it('still allows an ordinary safe regex', () => {
    expect(g([{ $match: { x: { $regex: '^abc' } } }]).allowed).toBe(true);
    expect(g([{ $match: { x: { $regularExpression: { pattern: '^abc', options: 'i' } } } }]).allowed).toBe(true);
  });
});

describe('M2 row cap bounds document size, not just count', () => {
  it('rejects an unbounded $push that embeds the whole collection', () => {
    const v = g([{ $group: { _id: null, all: { $push: '$$ROOT' } } }]);
    expect(v.allowed).toBe(false);
    expect(v.ruleId).toBe('unbounded_accumulator');
  });
  it('rejects an unbounded $addToSet', () => {
    expect(g([{ $group: { _id: null, all: { $addToSet: '$$ROOT' } } }]).ruleId).toBe('unbounded_accumulator');
  });
  it('allows a $push bounded by an earlier $limit', () => {
    expect(g([{ $limit: 10 }, { $group: { _id: null, all: { $push: '$$ROOT' } } }]).allowed).toBe(true);
  });
  it('injects a $limit into every $facet branch', () => {
    const v = guardPipeline(JSON.stringify([{ $facet: { a: [{ $match: {} }], b: [{ $sort: { x: 1 } }] } }]), {
      maxRows: 25,
      maxDepth: 400,
      maxRegexPatternLength: 200,
    });
    expect(v.allowed).toBe(true);
    const stages = JSON.parse(v.pipelineJson) as Record<string, unknown>[];
    const facet = stages[0]!['$facet'] as Record<string, Record<string, unknown>[]>;
    for (const branch of Object.values(facet)) {
      expect(branch[branch.length - 1]).toEqual({ $limit: 25 });
    }
    expect(v.autoLimited).toBe(true);
  });
  it('lowers an over-large trailing $limit inside a $facet branch', () => {
    const v = guardPipeline(JSON.stringify([{ $facet: { a: [{ $match: {} }, { $limit: 9_999_999 }] } }]), {
      maxRows: 25,
      maxDepth: 400,
      maxRegexPatternLength: 200,
    });
    expect(v.allowed).toBe(true);
    const stages = JSON.parse(v.pipelineJson) as Record<string, unknown>[];
    const branch = (stages[0]!['$facet'] as Record<string, Record<string, unknown>[]>)['a']!;
    expect(branch[branch.length - 1]).toEqual({ $limit: 25 });
    expect(v.loweredLimit).toBe(true);
  });
  it('rejects an unbounded $push hidden inside a $facet branch', () => {
    const v = g([{ $facet: { a: [{ $group: { _id: null, all: { $push: '$$ROOT' } } }] } }]);
    expect(v.allowed).toBe(false);
    expect(v.ruleId).toBe('unbounded_accumulator');
  });
});

describe('M5 out-of-range bare integer literals', () => {
  it('rejects a bare 64-bit integer above the JS safe range', () => {
    const v = guardPipeline('[{"$match": {"id": 1234567890123456789}}]');
    expect(v.allowed).toBe(false);
    expect(v.ruleId).toBe('integer_unsafe');
    expect(v.reason).toMatch(/\$numberLong/);
  });
  it('rejects a large negative bare integer', () => {
    expect(guardPipeline('[{"$match": {"id": -9223372036854775807}}]').ruleId).toBe('integer_unsafe');
  });
  it('allows the same value wrapped in $numberLong', () => {
    expect(guardPipeline('[{"$match": {"id": {"$numberLong": "1234567890123456789"}}}]').allowed).toBe(true);
  });
  it('leaves safe integers and non-integers alone', () => {
    expect(guardPipeline('[{"$match": {"a": 42, "b": 1000000, "c": 1.5}}]').allowed).toBe(true);
    expect(guardPipeline('[{"$match": {"a": 9007199254740991}}]').allowed).toBe(true);
  });
});
