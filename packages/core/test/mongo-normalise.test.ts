import { describe, expect, it } from 'vitest';
import { rewriteDistinctCount } from '../src/mongo/normalise.js';

const p = (json: string): unknown[] => JSON.parse(json) as unknown[];

describe('rewriteDistinctCount', () => {
  it('rewrites the $addToSet + $size idiom into a grouped count', () => {
    expect(
      rewriteDistinctCount(
        p(`[
          {"$group": {"_id": null, "distinctRegions": {"$addToSet": "$region"}}},
          {"$project": {"_id": 0, "n": {"$size": "$distinctRegions"}}}
        ]`),
      ),
    ).toEqual([{ $match: { region: { $exists: true } } }, { $group: { _id: '$region' } }, { $count: 'n' }]);
  });

  it('excludes documents missing the field, because $addToSet does', () => {
    // The reason the $match exists at all. Measured against MongoDB: five documents, three with a
    // region (two distinct) and two with no region field, is 2 by $addToSet+$size and 3 by a bare
    // $group - so without this guard the rewrite returns a different number with no error anywhere.
    const out = rewriteDistinctCount(
      p(`[
        {"$group": {"_id": null, "s": {"$addToSet": "$customer.city"}}},
        {"$project": {"n": {"$size": "$s"}}}
      ]`),
    );
    expect(out?.[0]).toEqual({ $match: { 'customer.city': { $exists: true } } });
  });

  it('keeps the stages that follow', () => {
    expect(
      rewriteDistinctCount(
        p(`[
          {"$group": {"_id": null, "s": {"$addToSet": "$region"}}},
          {"$project": {"n": {"$size": "$s"}}},
          {"$limit": 1000}
        ]`),
      ),
    ).toEqual([
      { $match: { region: { $exists: true } } },
      { $group: { _id: '$region' } },
      { $count: 'n' },
      { $limit: 1000 },
    ]);
  });

  it('accepts $addFields and $set in place of $project', () => {
    for (const stage of ['$addFields', '$set']) {
      expect(
        rewriteDistinctCount(
          p(`[{"$group": {"_id": null, "s": {"$addToSet": "$region"}}}, {"${stage}": {"n": {"$size": "$s"}}}]`),
        ),
      ).toEqual([{ $match: { region: { $exists: true } } }, { $group: { _id: '$region' } }, { $count: 'n' }]);
    }
  });

  it('refuses a grouped distinct count, which asks a different question', () => {
    // Per-region distinct reps is not the same as the number of distinct reps.
    expect(
      rewriteDistinctCount(
        p(`[
          {"$group": {"_id": "$region", "reps": {"$addToSet": "$rep"}}},
          {"$project": {"n": {"$size": "$reps"}}}
        ]`),
      ),
    ).toBeNull();
  });

  it('refuses when the group carries anything else', () => {
    expect(
      rewriteDistinctCount(
        p(`[
          {"$group": {"_id": null, "s": {"$addToSet": "$region"}, "total": {"$sum": "$amount"}}},
          {"$project": {"n": {"$size": "$s"}}}
        ]`),
      ),
    ).toBeNull();
  });

  it('refuses when the array is read more than once, or also returned', () => {
    expect(
      rewriteDistinctCount(
        p(`[
          {"$group": {"_id": null, "s": {"$addToSet": "$region"}}},
          {"$project": {"n": {"$size": "$s"}, "values": "$s"}}
        ]`),
      ),
    ).toBeNull();
  });

  it('refuses when a later stage still needs the array', () => {
    expect(
      rewriteDistinctCount(
        p(`[
          {"$group": {"_id": null, "s": {"$addToSet": "$region"}}},
          {"$project": {"n": {"$size": "$s"}}},
          {"$match": {"$expr": {"$in": ["North", "$s"]}}}
        ]`),
      ),
    ).toBeNull();
  });

  it('refuses $push, which does not deduplicate', () => {
    expect(
      rewriteDistinctCount(
        p(`[{"$group": {"_id": null, "s": {"$push": "$region"}}}, {"$project": {"n": {"$size": "$s"}}}]`),
      ),
    ).toBeNull();
  });

  it('refuses an expression in place of a plain field path', () => {
    expect(
      rewriteDistinctCount(
        p(`[
          {"$group": {"_id": null, "s": {"$addToSet": {"$toUpper": "$region"}}}},
          {"$project": {"n": {"$size": "$s"}}}
        ]`),
      ),
    ).toBeNull();
  });

  it('refuses anything that is not this exact shape', () => {
    expect(rewriteDistinctCount(p('[]'))).toBeNull();
    expect(rewriteDistinctCount(p('[{"$group": {"_id": null, "s": {"$addToSet": "$region"}}}]'))).toBeNull();
    expect(rewriteDistinctCount(p('[{"$match": {"a": 1}}, {"$count": "n"}]'))).toBeNull();
    expect(
      rewriteDistinctCount(
        p(`[{"$group": {"_id": null, "s": {"$addToSet": "$region"}}}, {"$project": {"n": {"$sum": "$s"}}}]`),
      ),
    ).toBeNull();
  });
});
