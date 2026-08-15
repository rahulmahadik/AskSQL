import { describe, expect, it } from 'vitest';
import { firstMisquotedField, firstUnknownStageField } from '../src/mongo/stage-fields.js';

const p = (json: string): unknown[] => JSON.parse(json) as unknown[];

describe('firstUnknownStageField', () => {
  it('catches a field a $group has already dropped', () => {
    // The pipeline a 7b model wrote for "average amount rounded": $orders is the collection name,
    // and after the $group the document holds only _id and totalAmount.
    const found = firstUnknownStageField(
      p(`[
        {"$group": {"_id": null, "totalAmount": {"$sum": "$amount"}}},
        {"$project": {"averageAmount": {"$divide": ["$totalAmount", {"$size": "$orders"}]}, "_id": 0}}
      ]`),
    );
    expect(found?.field).toBe('orders');
    expect(found?.stage).toBe(1);
    expect(found?.available).toEqual(['_id', 'totalAmount']);
  });

  it('accepts accumulator outputs and _id after a $group', () => {
    expect(
      firstUnknownStageField(
        p(`[
          {"$group": {"_id": "$region", "total": {"$sum": "$amount"}}},
          {"$project": {"region": "$_id", "total": "$total", "_id": 0}},
          {"$sort": {"total": -1}}
        ]`),
      ),
    ).toBeNull();
  });

  it('does not judge anything before a stage narrows the document', () => {
    // The catalog is sampled, so a field missing from the sample is not evidence of absence.
    expect(
      firstUnknownStageField(p('[{"$match": {"whatever": 1}}, {"$project": {"x": "$rarely_sampled"}}]')),
    ).toBeNull();
  });

  it('reads accumulator expressions against the pre-group document', () => {
    expect(
      firstUnknownStageField(
        p(`[
          {"$group": {"_id": "$region", "n": {"$sum": 1}}},
          {"$group": {"_id": null, "regions": {"$sum": "$n"}}}
        ]`),
      ),
    ).toBeNull();
  });

  it('counts $addFields and $set as producing their names', () => {
    expect(
      firstUnknownStageField(
        p(`[
          {"$group": {"_id": null, "total": {"$sum": "$amount"}}},
          {"$addFields": {"doubled": {"$multiply": ["$total", 2]}}},
          {"$project": {"doubled": "$doubled"}}
        ]`),
      ),
    ).toBeNull();
  });

  it('keeps every other field when a projection only drops _id', () => {
    // {$project: {_id: 0}} is a pure exclusion. Reading it as an inclusion wiped the document, and
    // the test that claimed to cover exclusions only ever used $unset.
    expect(
      firstUnknownStageField(
        p(`[
          {"$group": {"_id": null, "total": {"$sum": "$amount"}}},
          {"$project": {"_id": 0}},
          {"$addFields": {"x": {"$multiply": ["$total", 2]}}}
        ]`),
      ),
    ).toBeNull();
  });

  it('treats an exclusion projection as a removal', () => {
    const found = firstUnknownStageField(
      p(`[
        {"$group": {"_id": null, "a": {"$sum": 1}, "b": {"$sum": 1}}},
        {"$project": {"b": 0}},
        {"$project": {"x": "$b"}}
      ]`),
    );
    expect(found?.field).toBe('b');
  });

  it('adds the includeArrayIndex name and leaves $literal alone', () => {
    // Both were reported as unknown fields, which burned repair rounds on valid pipelines.
    expect(
      firstUnknownStageField(
        p(`[
          {"$group": {"_id": "$r", "items": {"$push": "$i"}}},
          {"$unwind": {"path": "$items", "includeArrayIndex": "idx"}},
          {"$project": {"idx": "$idx"}}
        ]`),
      ),
    ).toBeNull();
    expect(
      firstUnknownStageField(
        p(`[{"$group": {"_id": null, "t": {"$sum": 1}}}, {"$project": {"x": {"$literal": "$notAField"}}}]`),
      ),
    ).toBeNull();
  });

  it('treats $unset and exclusion projections as removals', () => {
    const found = firstUnknownStageField(
      p(`[
        {"$group": {"_id": null, "total": {"$sum": "$amount"}, "n": {"$sum": 1}}},
        {"$unset": ["n"]},
        {"$project": {"x": "$n"}}
      ]`),
    );
    expect(found?.field).toBe('n');
  });

  it('adds the $lookup output field and ignores the foreign sub-pipeline', () => {
    // $_id inside the sub-pipeline belongs to reps, not to the grouped document.
    expect(
      firstUnknownStageField(
        p(`[
          {"$group": {"_id": "$repId", "total": {"$sum": "$amount"}}},
          {"$lookup": {"from": "reps", "let": {"r": "$_id"},
                       "pipeline": [{"$match": {"$expr": {"$eq": ["$_id", "$$r"]}}}], "as": "rep"}},
          {"$project": {"rep": "$rep", "total": "$total"}}
        ]`),
      ),
    ).toBeNull();
  });

  it('gives up rather than guessing after a stage it cannot model', () => {
    for (const stage of ['{"$replaceRoot": {"newRoot": "$x"}}', '{"$facet": {"a": []}}', '{"$unionWith": "other"}']) {
      expect(
        firstUnknownStageField(
          p(`[{"$group": {"_id": null, "t": {"$sum": "$a"}}}, ${stage}, {"$project": {"z": "$gone"}}]`),
        ),
      ).toBeNull();
    }
  });

  it('leaves $$ variables and literals alone', () => {
    expect(
      firstUnknownStageField(
        p(`[
          {"$group": {"_id": null, "t": {"$sum": "$amount"}}},
          {"$project": {"now": "$$NOW", "label": "plain text", "t": "$t"}}
        ]`),
      ),
    ).toBeNull();
  });

  it('resolves a dotted path by its root', () => {
    const found = firstUnknownStageField(
      p(`[{"$group": {"_id": null, "t": {"$sum": "$amount"}}}, {"$project": {"c": "$customer.city"}}]`),
    );
    expect(found?.field).toBe('customer');
  });

  it('keeps the field after $unwind', () => {
    expect(
      firstUnknownStageField(
        p(`[
          {"$group": {"_id": null, "items": {"$push": "$items"}}},
          {"$unwind": "$items"},
          {"$project": {"sku": "$items.sku"}}
        ]`),
      ),
    ).toBeNull();
  });

  it('narrows to the $count output name', () => {
    const found = firstUnknownStageField(
      p(`[{"$group": {"_id": "$region"}}, {"$count": "n"}, {"$project": {"x": "$region"}}]`),
    );
    expect(found?.field).toBe('region');
    expect(found?.available).toEqual(['n']);
  });
});

describe('firstMisquotedField', () => {
  const fields = new Set(['total amount', 'customer-name', 'Status', '_internal.created at', 'plain']);

  it('catches the backtick quoting a 7b model borrows from SQL', () => {
    // MongoDB has no field quoting, so $sum over this returns 0 rather than failing.
    const found = firstMisquotedField(p('[{"$group": {"_id": null, "t": {"$sum": "$`total amount`"}}}]'), fields);
    expect(found).toEqual({ raw: '`total amount`', suggestion: 'total amount' });
  });

  it('catches double quotes and brackets too', () => {
    expect(firstMisquotedField(p('[{"$project": {"x": "$\\"total amount\\""}}]'), fields)?.suggestion).toBe(
      'total amount',
    );
    expect(firstMisquotedField(p('[{"$project": {"x": "$[customer-name]"}}]'), fields)?.suggestion).toBe(
      'customer-name',
    );
  });

  it('checks each segment of a dotted path', () => {
    const found = firstMisquotedField(p('[{"$project": {"x": "$_internal.`created at`"}}]'), fields);
    expect(found?.suggestion).toBe('_internal.created at');
  });

  it('leaves correct references alone', () => {
    expect(firstMisquotedField(p('[{"$group": {"_id": null, "t": {"$sum": "$total amount"}}}]'), fields)).toBeNull();
    expect(firstMisquotedField(p('[{"$project": {"x": "$plain", "y": "$$NOW"}}]'), fields)).toBeNull();
  });

  it('stays silent when the unquoted name is not a catalog field either', () => {
    // Without that proof the reference is merely unrecognised, and the catalog is only a sample.
    expect(firstMisquotedField(p('[{"$project": {"x": "$`no such field`"}}]'), fields)).toBeNull();
  });
});
