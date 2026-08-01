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

describe('mongo-shell syntax (what small models actually emit)', () => {
  it('accepts unquoted stage keys, the form the mongo shell itself uses', () => {
    const v = guardPipeline('[{$group: {_id: "$customer_id", n: {$sum: 1}}}]');
    expect(v.allowed).toBe(true);
    // Re-serialized strictly, so everything downstream still sees plain JSON.
    expect(v.pipelineJson).toContain('"$group"');
  });

  it('accepts single-quoted strings', () => {
    const v = guardPipeline("[{$match: {status: 'shipped'}}]");
    expect(v.allowed).toBe(true);
    expect(JSON.parse(v.pipelineJson)[0].$match.status).toBe('shipped');
  });

  it('accepts a trailing comma', () => {
    expect(guardPipeline('[{"$match": {"a": 1},}]').allowed).toBe(true);
  });

  it('keeps colons, braces and commas that live inside string values', () => {
    const v = guardPipeline('[{$match: {note: "a:b, {c} d"}}]');
    expect(JSON.parse(v.pipelineJson)[0].$match.note).toBe('a:b, {c} d');
  });

  it('keeps true/false/null literals as literals, not strings', () => {
    const v = guardPipeline('[{$match: {active: true, deleted: null}}]');
    const m = JSON.parse(v.pipelineJson)[0].$match;
    expect(m.active).toBe(true);
    expect(m.deleted).toBeNull();
  });

  it('preserves an escaped quote inside a single-quoted string', () => {
    const v = guardPipeline("[{$match: {name: 'O\\'Brien'}}]");
    expect(JSON.parse(v.pipelineJson)[0].$match.name).toBe("O'Brien");
  });

  // Asserting only `allowed === false` would pass even if the pipeline never parsed at all,
  // which is exactly the regression these tests exist to catch: the GUARD must reject it.
  it('still blocks a forbidden stage written in shell syntax - relaxing the parser is not relaxing the guard', () => {
    const v = guardPipeline('[{$match: {$where: "this.total > 0"}}]');
    expect(v.allowed).toBe(false);
    expect(v.ruleId).not.toBe('parse_failed');
  });

  it('still blocks a write stage written in shell syntax', () => {
    const v = guardPipeline('[{$out: "stolen"}]');
    expect(v.allowed).toBe(false);
    expect(v.ruleId).not.toBe('parse_failed');
  });

  it('rejects text that is not a pipeline at all', () => {
    expect(guardPipeline('not a pipeline').allowed).toBe(false);
  });
});

describe('relaxed parsing is shape-only: it must not widen what runs', () => {
  // A seeded generator, so a failure names a reproducible pipeline rather than a random one.
  const rand = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  it('leaves valid strict JSON byte-identical over 200 generated pipelines', () => {
    const r = rand(7);
    const alphabet = ['a', 'Z', '0', ' ', ':', ',', '{', '}', '[', ']', '"', "'", '\\', '\n', 'é', '$', '.'];
    const str = () => Array.from({ length: Math.floor(r() * 10) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
    const val = (d = 0): unknown => {
      switch (Math.floor(r() * (d > 2 ? 4 : 6))) {
        case 0: return str();
        case 1: return Math.floor(r() * 1000) - 500;
        case 2: return r() < 0.5;
        case 3: return null;
        case 4: return [val(d + 1), val(d + 1)];
        default: return { [`f${Math.floor(r() * 4)}`]: val(d + 1) };
      }
    };
    for (let i = 0; i < 200; i++) {
      const json = JSON.stringify([{ $match: val() }, { $limit: 5 }]);
      expect(JSON.stringify(parsePipeline(json))).toBe(json);
    }
  });

  it('round-trips the same 200 pipelines through the RELAXER, not just JSON.parse', () => {
    const r = rand(11);
    const alphabet = ['a', 'Z', '0', ' ', ':', ',', '{', '}', '[', ']', 'é', '$', '.'];
    const str = () => Array.from({ length: Math.floor(r() * 10) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
    const val = (d = 0): unknown => {
      switch (Math.floor(r() * (d > 2 ? 4 : 6))) {
        case 0: return str();
        case 1: return Math.floor(r() * 1000) - 500;
        case 2: return r() < 0.5;
        case 3: return null;
        case 4: return [val(d + 1), val(d + 1)];
        default: return { [`f${Math.floor(r() * 4)}`]: val(d + 1) };
      }
    };
    for (let i = 0; i < 200; i++) {
      const pipeline = [{ $match: val() }, { $limit: 5 }];
      const strict = JSON.stringify(pipeline);
      // Unquote the keys so the direct JSON.parse FAILS and relaxShellJson is the path under test.
      const shell = strict.replace(/"(\$?[A-Za-z_]\w*)":/g, '$1:');
      expect(shell).not.toBe(strict);
      expect(JSON.stringify(parsePipeline(shell))).toBe(strict);
    }
  });

  it.each([
    ['unquoted $where', '[{$match: {$where: "this.x > 1"}}]'],
    ['single-quoted $where', "[{$match: {$where: 'this.x > 1'}}]"],
    ['unquoted $out', '[{$out: "stolen"}]'],
    ['unquoted $merge', "[{$merge: {into: 'other'}}]"],
    ['$function in shell form', '[{$match: {$function: {body: "function(){}", args: [], lang: "js"}}}]'],
    ['$out nested in $unionWith', '[{$unionWith: {coll: "x", pipeline: [{$out: "y"}]}}]'],
  ])('still blocks %s', (_name, pipeline) => {
    const v = guardPipeline(pipeline);
    expect(v.allowed).toBe(false);
    // Not parse_failed: the pipeline must reach the guard and be rejected on its merits.
    expect(v.ruleId).not.toBe('parse_failed');
  });

  it('cannot be used to pollute Object.prototype', () => {
    for (const p of [
      '[{$match: {__proto__: {polluted: true}}}]',
      '[{"$match": {"__proto__": {"polluted": true}}}]',
      '[{$match: {constructor: {prototype: {polluted: true}}}}]',
    ]) {
      guardPipeline(p);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps numbers, booleans and null typed rather than stringifying them', () => {
    const v = guardPipeline('[{$match: {t: true, f: false, n: null, num: 1.5e3}}]');
    expect(v.allowed).toBe(true);
    expect(JSON.parse(v.pipelineJson)[0].$match).toEqual({ t: true, f: false, n: null, num: 1500 });
  });
});

describe('the unsafe-integer check reads what was actually parsed', () => {
  it('blocks a 64-bit literal even when shell quoting hides it from a strict-JSON scanner', () => {
    // A single-quoted string containing a double quote desynchronises a strict-JSON scanner,
    // so later numbers are skipped and JSON.parse silently truncates the id.
    const v = guardPipeline(`[{"$match": {"note": 'say "x', "big": 12345678901234567890}}]`);
    expect(v.allowed).toBe(false);
    expect(v.ruleId).toBe('integer_unsafe');
  });

  it('does not block a long numeric STRING written in single quotes', () => {
    const v = guardPipeline("[{$match: {phone: '12345678901234567890'}}]");
    expect(v.allowed).toBe(true);
    expect(JSON.parse(v.pipelineJson)[0].$match.phone).toBe('12345678901234567890');
  });

  it('still allows the documented $numberLong form', () => {
    expect(guardPipeline('[{"$match": {"big": {"$numberLong": "12345678901234567890"}}}]').allowed).toBe(true);
  });
});
