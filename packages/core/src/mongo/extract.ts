/**
 * Pipeline extraction from model output. The model emits a mongosh-style
 * `db.<collection>.aggregate([ ...stages... ])` call, ideally in a ```js fence,
 * followed by a plain-language explanation. This parses out the collection name
 * and the bare pipeline array, robust to prose wrapping and multiple fences.
 */

import { extractImpossible } from '../extract.js';

export interface MongoExtraction {
  readonly collection: string;
  /** The bare pipeline array text, e.g. `[ {"$match": {...}} ]`. */
  readonly pipelineJson: string;
  readonly explanation: string;
  readonly source: 'fence' | 'whole';
}

export { extractImpossible };

const FENCE_RE = /```(?:js|javascript|json)?\s*\n?([\s\S]*?)```/gu;

/** Three ways the model may name the collection: db.name, db.getCollection("name"), db["name"]. */
const AGGREGATE_CALL_RE =
  /db\s*(?:\.\s*([A-Za-z_$][\w$]*)|\.\s*getCollection\s*\(\s*["']([^"']+)["']\s*\)|\[\s*["']([^"']+)["']\s*\])\s*\.\s*aggregate\s*\(/u;

/** Walk from `open` (index of the '(') to its matching ')', respecting JSON string literals. */
function findMatchingClose(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === '\\')
        i++; // skip the escaped char
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractFrom(candidate: string): Omit<MongoExtraction, 'explanation' | 'source'> | null {
  const m = AGGREGATE_CALL_RE.exec(candidate);
  if (!m) return null;
  const collection = m[1] ?? m[2] ?? m[3];
  if (!collection) return null;
  const open = candidate.indexOf('(', m.index + m[0].length - 1);
  if (open < 0) return null;
  const close = findMatchingClose(candidate, open);
  if (close < 0) return null;
  const inner = candidate.slice(open + 1, close).trim();
  // The argument to aggregate() must be an array literal.
  if (!inner.startsWith('[')) return null;
  return { collection, pipelineJson: inner };
}

function tidy(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 2000);
}

export function extractPipeline(text: string): MongoExtraction | null {
  const raw = text ?? '';

  // 1) Fenced blocks - first fence that yields an aggregate call wins.
  const fences = [...raw.matchAll(FENCE_RE)];
  for (const f of fences) {
    const found = extractFrom((f[1] ?? '').trim());
    if (found) {
      const explanation = raw.replace(f[0]!, ' ').replace(/```[\s\S]*?```/gu, ' ');
      return { ...found, explanation: tidy(explanation), source: 'fence' };
    }
  }

  // 2) Whole message.
  const found = extractFrom(raw.trim());
  if (found) return { ...found, explanation: '', source: 'whole' };
  return null;
}
