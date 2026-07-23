/**
 * The AskSQL security boundary for MongoDB.
 *
 * MongoDB has no read-only session flag, so this guard is the only safety floor.
 * It is an allowlist over a parsed aggregation pipeline: only known read-only
 * stages pass, writes ($out/$merge) and JS-execution operators ($where/$function/
 * $accumulator) are refused, and a final $limit is injected/lowered to the row cap.
 * Fail-closed: anything unparseable or shaped wrong is blocked.
 */

export interface MongoGuardPolicy {
  readonly maxRows: number;
  readonly maxDepth: number;
  readonly maxRegexPatternLength: number;
}

export const DEFAULT_MONGO_GUARD_POLICY: MongoGuardPolicy = Object.freeze({
  maxRows: 1000,
  maxDepth: 400,
  maxRegexPatternLength: 200,
});

export interface MongoGuardVerdict {
  readonly allowed: boolean;
  /** The re-serialized, capped pipeline as a bare JSON array string. Meaningful only when allowed. */
  readonly pipelineJson: string;
  readonly ruleId?: string;
  readonly reason?: string;
  readonly autoLimited: boolean;
  readonly loweredLimit: boolean;
  /** Collections referenced by $lookup / $graphLookup / $unionWith, for the hallucination floor. */
  readonly collections: readonly string[];
}

/**
 * Read-only aggregation stages. This is an allowlist: writes ($out, $merge) and
 * server-introspection stages ($currentOp, $collStats, $indexStats, $listSessions,
 * $listLocalSessions, $planCacheStats) are simply absent, so they are refused.
 */
const ALLOWED_STAGES = new Set([
  '$match',
  '$project',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$unwind',
  '$lookup',
  '$facet',
  '$count',
  '$sample',
  '$addFields',
  '$set',
  '$replaceRoot',
  '$replaceWith',
  '$bucket',
  '$bucketAuto',
  '$sortByCount',
  '$graphLookup',
  '$unionWith',
  '$geoNear',
  '$redact',
  '$unset',
  '$setWindowFields',
  '$densify',
  '$fill',
  '$documents',
  '$search',
  '$searchMeta',
]);

/** Operators that run arbitrary server-side JavaScript, at any depth. Always refused. */
const DENIED_OPERATORS_ANYWHERE = new Set(['$where', '$function', '$accumulator']);

/** Aggregation operators that carry a regex under a `regex` field. */
const REGEX_OPERATORS = new Set(['$regexMatch', '$regexFind', '$regexFindAll']);

/** Accumulators that build an unbounded array; a $group using one needs an earlier bound. */
const ARRAY_ACCUMULATORS = new Set(['$push', '$addToSet']);

/** A crude nested-quantifier heuristic for catastrophic-backtracking (ReDoS) regexes. */
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)[+*]/;

/** Largest bare integer JSON.parse preserves exactly; larger literals silently lose precision. */
const SAFE_INT = BigInt(Number.MAX_SAFE_INTEGER);

function blocked(ruleId: string, reason: string): MongoGuardVerdict {
  return { allowed: false, pipelineJson: '', ruleId, reason, autoLimited: false, loweredLimit: false, collections: [] };
}

type Doc = Record<string, unknown>;

const isDoc = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse a bare pipeline-array string into stages, or null if it is not a JSON array. */
export function parsePipeline(pipelineJson: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(pipelineJson);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

type Violation = { ruleId: string; reason: string };

/** Length + catastrophic-backtracking checks on a single regex pattern string. */
function checkPattern(pattern: string, policy: MongoGuardPolicy): Violation | null {
  if (pattern.length > policy.maxRegexPatternLength) {
    return { ruleId: 'regex_too_long', reason: 'A regular expression in the query is too long.' };
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    return { ruleId: 'regex_unsafe', reason: 'A regular expression in the query could run for an unbounded time.' };
  }
  return null;
}

/** The inspectable pattern string from a regex carrier, or 'opaque' when it cannot be read as text. */
function regexPatternOf(v: unknown): string | 'opaque' {
  if (typeof v === 'string') return v;
  if (isDoc(v)) {
    // Canonical EJSON regex: {$regularExpression:{pattern,options}}.
    const ejson = v['$regularExpression'];
    if (isDoc(ejson)) return typeof ejson['pattern'] === 'string' ? (ejson['pattern'] as string) : 'opaque';
    // The inner {pattern,options} form (also a BSONRegExp shape).
    if ('pattern' in v) return typeof v['pattern'] === 'string' ? (v['pattern'] as string) : 'opaque';
  }
  return 'opaque';
}

/** Apply the length + ReDoS heuristic to a regex carrier, failing closed on an unreadable pattern. */
function inspectRegex(v: unknown, policy: MongoGuardPolicy): Violation | null {
  const pattern = regexPatternOf(v);
  if (pattern === 'opaque') {
    return { ruleId: 'regex_opaque', reason: 'A regular expression in the query could not be inspected for safety.' };
  }
  return checkPattern(pattern, policy);
}

/** True if any denied operator, oversized regex, or ReDoS pattern hides anywhere in the value tree. */
function scanValue(value: unknown, policy: MongoGuardPolicy, depth: number): Violation | null {
  if (depth > policy.maxDepth) return { ruleId: 'too_deep', reason: 'The pipeline is nested too deeply.' };
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = scanValue(item, policy, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (isDoc(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (DENIED_OPERATORS_ANYWHERE.has(key)) {
        return {
          ruleId: `operator_denied:${key}`,
          reason: `The ${key} operator runs server-side code and is not allowed.`,
        };
      }
      // Bound every regex carrier, not just $regex strings: $regularExpression and $regexMatch/Find/FindAll too.
      if (key === '$regex' || key === '$regularExpression') {
        const hit = inspectRegex(v, policy);
        if (hit) return hit;
      } else if (REGEX_OPERATORS.has(key) && isDoc(v) && 'regex' in v) {
        const hit = inspectRegex(v['regex'], policy);
        if (hit) return hit;
      }
      const hit = scanValue(v, policy, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Collect a collection name from a $lookup/$graphLookup/$unionWith stage spec. */
function collectRefs(stageName: string, spec: unknown, out: Set<string>): void {
  if (stageName === '$lookup' || stageName === '$graphLookup') {
    if (isDoc(spec) && typeof spec['from'] === 'string') out.add(spec['from']);
  } else if (stageName === '$unionWith') {
    if (typeof spec === 'string') out.add(spec);
    else if (isDoc(spec) && typeof spec['coll'] === 'string') out.add(spec['coll']);
  }
}

/** Sub-pipelines that must be re-validated with the same rules. */
function subPipelines(stageName: string, spec: unknown): unknown[][] {
  const out: unknown[][] = [];
  if (isDoc(spec)) {
    if ((stageName === '$lookup' || stageName === '$unionWith') && Array.isArray(spec['pipeline'])) {
      out.push(spec['pipeline'] as unknown[]);
    }
    if (stageName === '$facet') {
      for (const branch of Object.values(spec)) if (Array.isArray(branch)) out.push(branch as unknown[]);
    }
  }
  return out;
}

/** True if a $group spec accumulates into an array via $push/$addToSet anywhere. */
function hasArrayAccumulator(spec: unknown): boolean {
  if (Array.isArray(spec)) return spec.some(hasArrayAccumulator);
  if (isDoc(spec)) {
    for (const [k, v] of Object.entries(spec)) {
      if (ARRAY_ACCUMULATORS.has(k)) return true;
      if (hasArrayAccumulator(v)) return true;
    }
  }
  return false;
}

/** A $limit or sized $sample stage bounds how many documents later stages can accumulate. */
function boundsRowCount(name: string, spec: unknown): boolean {
  if (name === '$limit') return typeof spec === 'number';
  if (name === '$sample') return isDoc(spec) && typeof spec['size'] === 'number';
  return false;
}

interface WalkResult {
  readonly violation?: Violation;
  readonly collections: Set<string>;
}

function walkPipeline(
  pipeline: unknown[],
  policy: MongoGuardPolicy,
  depth: number,
  collections: Set<string>,
): WalkResult {
  if (depth > policy.maxDepth)
    return { violation: { ruleId: 'too_deep', reason: 'The pipeline is nested too deeply.' }, collections };
  // A $push/$addToSet with no earlier bound collects the whole collection into one
  // document, sliding past the row cap; require a preceding $limit/$sample.
  let bounded = false;
  for (const stage of pipeline) {
    if (!isDoc(stage))
      return { violation: { ruleId: 'invalid_stage', reason: 'Each pipeline stage must be an object.' }, collections };
    const keys = Object.keys(stage);
    if (keys.length !== 1)
      return {
        violation: { ruleId: 'invalid_stage', reason: 'Each pipeline stage must have exactly one operator.' },
        collections,
      };
    const name = keys[0]!;
    if (!ALLOWED_STAGES.has(name)) {
      return {
        violation: { ruleId: `stage_denied:${name}`, reason: `The ${name} stage is not a read-only operation.` },
        collections,
      };
    }
    const spec = stage[name];
    const scan = scanValue(spec, policy, depth + 1);
    if (scan) return { violation: scan, collections };
    if (name === '$group' && !bounded && hasArrayAccumulator(spec)) {
      return {
        violation: {
          ruleId: 'unbounded_accumulator',
          reason: 'A $push/$addToSet collects an unbounded array; add a $limit before the $group.',
        },
        collections,
      };
    }
    if (boundsRowCount(name, spec)) bounded = true;
    collectRefs(name, spec, collections);
    for (const sub of subPipelines(name, spec)) {
      const r = walkPipeline(sub, policy, depth + 1, collections);
      if (r.violation) return r;
    }
  }
  return { collections };
}

/** Inspect the final stage's row limit (only the last stage governs output size). */
function limitDecision(pipeline: unknown[], maxRows: number): 'none' | 'high' | 'ok' {
  const last = pipeline[pipeline.length - 1];
  if (isDoc(last) && Object.keys(last).length === 1 && typeof last['$limit'] === 'number') {
    return (last['$limit'] as number) > maxRows ? 'high' : 'ok';
  }
  return 'none';
}

/**
 * Cap a (sub)pipeline's output at maxRows by injecting or lowering a trailing $limit,
 * recursing into every $facet branch so a facet cannot embed an unbounded array.
 */
function capPipeline(pipeline: unknown[], maxRows: number): { autoLimited: boolean; loweredLimit: boolean } {
  let autoLimited = false;
  let loweredLimit = false;
  for (const stage of pipeline) {
    if (isDoc(stage) && isDoc(stage['$facet'])) {
      const facet = stage['$facet'] as Doc;
      for (const branch of Object.values(facet)) {
        if (Array.isArray(branch)) {
          const r = capPipeline(branch as unknown[], maxRows);
          autoLimited ||= r.autoLimited;
          loweredLimit ||= r.loweredLimit;
        }
      }
    }
  }
  const decision = limitDecision(pipeline, maxRows);
  if (decision === 'none') {
    pipeline.push({ $limit: maxRows });
    autoLimited = true;
  } else if (decision === 'high') {
    pipeline[pipeline.length - 1] = { $limit: maxRows };
    loweredLimit = true;
  }
  return { autoLimited, loweredLimit };
}

/**
 * True if the JSON text holds a bare integer literal outside the JS safe-integer
 * range. JSON.parse silently rounds such literals before EJSON can preserve them,
 * corrupting 64-bit ids; callers must wrap them in {$numberLong:"..."}.
 */
function hasUnsafeIntegerLiteral(json: string): boolean {
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = c === '-' ? i + 1 : i;
      const digitsStart = j;
      while (j < json.length && json[j]! >= '0' && json[j]! <= '9') j++;
      const next = json[j];
      const isInteger = next !== '.' && next !== 'e' && next !== 'E';
      // Only integers of ~16+ digits can exceed the safe range; BigInt-compare those.
      if (isInteger && j - digitsStart >= 16) {
        const val = BigInt(json.slice(i, j));
        if (val > SAFE_INT || val < -SAFE_INT) return true;
      }
      i = Math.max(i, j - 1);
    }
  }
  return false;
}

/**
 * Validate a MongoDB aggregation pipeline (a bare JSON-array string). Returns an
 * allowed verdict with the capped pipeline, or a blocked verdict with a stable ruleId.
 */
export function guardPipeline(
  pipelineJson: string,
  policy: MongoGuardPolicy = DEFAULT_MONGO_GUARD_POLICY,
): MongoGuardVerdict {
  const pipeline = parsePipeline(pipelineJson);
  if (!pipeline) return blocked('parse_failed', 'The pipeline is not valid JSON.');
  if (hasUnsafeIntegerLiteral(pipelineJson)) {
    return blocked(
      'integer_unsafe',
      'A number in the pipeline is too large to run safely. Wrap 64-bit integers in {"$numberLong": "..."}.',
    );
  }

  const collections = new Set<string>();
  const walk = walkPipeline(pipeline, policy, 0, collections);
  if (walk.violation) return blocked(walk.violation.ruleId, walk.violation.reason);

  const capped = [...pipeline];
  const { autoLimited, loweredLimit } = capPipeline(capped, policy.maxRows);

  return {
    allowed: true,
    pipelineJson: JSON.stringify(capped),
    autoLimited,
    loweredLimit,
    collections: [...collections],
  };
}
