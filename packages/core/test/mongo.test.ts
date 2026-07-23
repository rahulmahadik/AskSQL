import { describe, expect, it } from 'vitest';
import { guardPipeline } from '../src/mongo/guard.js';
import { extractPipeline } from '../src/mongo/extract.js';
import { buildPipelineSystem, buildPipelineUser, buildMongoRepairUser } from '../src/mongo/prompts.js';

const parse = (v: { pipelineJson: string }) => JSON.parse(v.pipelineJson) as Record<string, unknown>[];

describe('MongoGuard', () => {
  it('allows a read-only pipeline and injects a final $limit', () => {
    const v = guardPipeline('[{"$match": {"status": "active"}}]', {
      maxRows: 100,
      maxDepth: 400,
      maxRegexPatternLength: 200,
    });
    expect(v.allowed).toBe(true);
    expect(v.autoLimited).toBe(true);
    const stages = parse(v);
    expect(stages[stages.length - 1]).toEqual({ $limit: 100 });
  });

  it('lowers a too-high final $limit', () => {
    const v = guardPipeline('[{"$match": {}}, {"$limit": 10000}]', {
      maxRows: 100,
      maxDepth: 400,
      maxRegexPatternLength: 200,
    });
    expect(v.allowed).toBe(true);
    expect(v.loweredLimit).toBe(true);
    const stages = parse(v);
    expect(stages[stages.length - 1]).toEqual({ $limit: 100 });
  });

  it('blocks write stages ($out, $merge) — not in the allowlist', () => {
    expect(guardPipeline('[{"$out": "evil"}]').allowed).toBe(false);
    expect(guardPipeline('[{"$merge": {"into": "evil"}}]').allowed).toBe(false);
  });

  it('blocks server-introspection stages', () => {
    expect(guardPipeline('[{"$collStats": {}}]').allowed).toBe(false);
    expect(guardPipeline('[{"$indexStats": {}}]').allowed).toBe(false);
  });

  it('blocks JS-execution operators at any depth', () => {
    expect(guardPipeline('[{"$match": {"$where": "this.x > 1"}}]').allowed).toBe(false);
    expect(guardPipeline('[{"$project": {"y": {"$function": {"body": "f"}}}}]').allowed).toBe(false);
    expect(guardPipeline('[{"$group": {"_id": null, "v": {"$accumulator": {}}}}]').allowed).toBe(false);
  });

  it('blocks a denied operator hidden in a $lookup sub-pipeline', () => {
    const p = '[{"$lookup": {"from": "u", "pipeline": [{"$match": {"$where": "1"}}], "as": "x"}}]';
    expect(guardPipeline(p).allowed).toBe(false);
  });

  it('rejects a stage with more than one operator', () => {
    expect(guardPipeline('[{"$match": {}, "$limit": 5}]').allowed).toBe(false);
  });

  it('blocks oversized and ReDoS regexes', () => {
    const long = '[{"$match": {"name": {"$regex": "' + 'a'.repeat(300) + '"}}}]';
    expect(guardPipeline(long).ruleId).toBe('regex_too_long');
    expect(guardPipeline('[{"$match": {"name": {"$regex": "(a+)+"}}}]').ruleId).toBe('regex_unsafe');
  });

  it('fails closed on invalid JSON', () => {
    expect(guardPipeline('not json').allowed).toBe(false);
    expect(guardPipeline('{"$match": {}}').allowed).toBe(false); // object, not an array
  });

  it('collects referenced collections for the hallucination floor', () => {
    const p = '[{"$lookup": {"from": "orders", "as": "o"}}, {"$unionWith": "archive"}]';
    const v = guardPipeline(p);
    expect(v.allowed).toBe(true);
    expect([...v.collections].sort()).toEqual(['archive', 'orders']);
  });
});

describe('extractPipeline', () => {
  it('parses a fenced db.<coll>.aggregate([...]) call and the explanation', () => {
    const text =
      'Here you go:\n```js\ndb.orders.aggregate([{"$match": {"total": {"$gt": 100}}}])\n```\nThis finds big orders.';
    const e = extractPipeline(text);
    expect(e?.collection).toBe('orders');
    expect(JSON.parse(e!.pipelineJson)).toEqual([{ $match: { total: { $gt: 100 } } }]);
    expect(e?.explanation).toContain('big orders');
  });

  it('handles getCollection("name") and db["name"] forms', () => {
    expect(extractPipeline('db.getCollection("my-coll").aggregate([])')?.collection).toBe('my-coll');
    expect(extractPipeline('db["with space"].aggregate([{"$count": "n"}])')?.collection).toBe('with space');
  });

  it('respects nested brackets and string literals when finding the close paren', () => {
    const e = extractPipeline('db.t.aggregate([{"$match": {"note": "a) tricky ] string"}}])');
    expect(e?.collection).toBe('t');
    expect(JSON.parse(e!.pipelineJson)).toEqual([{ $match: { note: 'a) tricky ] string' } }]);
  });

  it('returns null when no aggregate call is present', () => {
    expect(extractPipeline('I cannot answer that.')).toBeNull();
    expect(extractPipeline('db.t.find({})')).toBeNull(); // find(), not aggregate()
  });
});

describe('Mongo prompts', () => {
  it('bakes the row cap into the system prompt and never leaks $ escaping', () => {
    const sys = buildPipelineSystem(250);
    expect(sys).toContain('at most 250');
    expect(sys).toContain('$match');
    expect(sys).not.toContain('\\$');
  });

  it('wraps the schema as untrusted and appends the question', () => {
    const user = buildPipelineUser({ question: 'how many orders', schemaText: 'COLLECTION orders' });
    expect(user).toContain('<schema>');
    expect(user).toContain('</schema>');
    expect(user.trimEnd().endsWith('Question: how many orders')).toBe(true);
  });

  it('repair prompt includes the failure and the failed pipeline', () => {
    const r = buildMongoRepairUser({
      question: 'q',
      failedPipeline: '[{"$out":"x"}]',
      failure: 'stage_denied:$out',
      schemaText: 's',
    });
    expect(r).toContain('stage_denied:$out');
    expect(r).toContain('$out');
  });
});
