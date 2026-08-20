/**
 * SQL extraction from model output.
 * Robust to fenced blocks, prose wrapping, and multiple fences.
 */

// Any language tag is consumed; the candidate is still gated by SQL_START_RE.
const FENCE_RE = /```[A-Za-z0-9+_-]*\s*\n?([\s\S]*?)```/gu;

/** Any statement-shaped start, including write/DDL verbs: the guard, not the extractor, decides what may run. */
const SQL_START_RE =
  /^(select|with|explain|show|describe|desc|pragma|insert|update|delete|drop|create|alter|truncate|merge|replace|call|grant|revoke|copy|values|table)\b/iu;

/** Conservative set for inline extraction from prose - read verbs only. */
const INLINE_START_RE = /(?:^|\n)\s*((?:select|with|explain)\b[\s\S]*?)(?=\n\s*\n|$)/iu;

export interface Extraction {
  readonly sql: string;
  readonly explanation: string;
  readonly source: 'fence' | 'inline' | 'whole';
}

/** Sentinel the prompt asks the model to emit when a question is unanswerable. */
export const IMPOSSIBLE_SENTINEL = /^\s*IMPOSSIBLE\s*:\s*(.+)/su;

const REASON_MAX_LENGTH = 300;
/** The sentinel word is internal protocol; a model that repeats it mid-sentence must not leak it into the chat. */
const SENTINEL_WORD = /\bIMPOSSIBLE\b\s*:?\s*/gi;
/** "Your question isn't about this data" said many robotic ways; all collapse to one plain sentence. */
const OFF_TOPIC =
  /\b(the )?question (cannot be answered|is not|isn't)\b[^.]*\b(not related to|unrelated to|does not relate)\b|\bnot related to the (provided )?schema\b/i;
/** Model-speak to plain English, applied in order. Deterministic, no second model call. */
const PHRASINGS: readonly (readonly [RegExp, string])[] = [
  [/\bthe provided schema\b/gi, 'this database'],
  [/\bthe (given |current )?schema\b/gi, 'this database'],
  [/\bdoes not contain any information (about|on|related to)\b/gi, "doesn't have anything about"],
  [/\bdoes not contain any\b/gi, "doesn't have any"],
  [/\bdoes not contain\b/gi, "doesn't have"],
  [/\bdoes not (include|have|provide)\b/gi, "doesn't have"],
  [/\bis not able to\b|\bcannot be\b/gi, "can't be"],
];

function humanizeReason(reason: string): string {
  if (OFF_TOPIC.test(reason)) return "That question isn't about the data in this database.";
  let out = reason;
  for (const [pattern, replacement] of PHRASINGS) out = out.replace(pattern, replacement);
  return out.replace(/\s{2,}/g, ' ').trim();
}

function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The first line after "IMPOSSIBLE:" is the reason; the sentinel is stripped and stiff phrasing humanized. */
export function extractImpossible(text: string): string | null {
  const m = IMPOSSIBLE_SENTINEL.exec(withoutReasoning(text).trim());
  if (!m) return null;
  const firstLine = m[1]!.trim().split('\n')[0]!.trim();
  const cleaned = firstLine.replace(SENTINEL_WORD, '').trim();
  const humanized = humanizeReason(cleaned);
  const sentenceCased = humanized.charAt(0).toUpperCase() + humanized.slice(1);
  return truncateAtWordBoundary(sentenceCased, REASON_MAX_LENGTH);
}

/**
 * A reasoning model narrates before it answers. Groq's qwen3.6 opens with "<think>\nHere's a thinking
 * process:", and that text was shown to the reader as the query's description. Worse, an answer cut off
 * mid-reasoning leaves the tag unclosed, so everything after it is narration with no answer in it.
 */
const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/giu;
// Anchored: unanchored, a tag inside the answer truncated `WHERE body LIKE '%<think>%'` to an
// unterminated literal.
const THINK_UNCLOSED = /^\s*<(?:think|thinking|reasoning)>[\s\S]*$/iu;

/**
 * Hides a reasoning model's narration as it streams; the whole-text strip only cleans the assembled
 * reply, so a streaming host forwarded the monologue live. Only a tag that OPENS the reply counts: one
 * appearing later is content. A tag split across chunks is held back until it can be read.
 */
export function createReasoningFilter(): (chunk: string) => string {
  const OPEN = /<(think|thinking|reasoning)>/i;
  const CLOSE = /<\/(think|thinking|reasoning)>/i;
  const LONGEST_TAG = '</reasoning>'.length;
  let phase: 'leading' | 'narrating' | 'passthrough' = 'leading';
  let carry = '';

  return (chunk: string): string => {
    let buffer = carry + chunk;
    carry = '';

    if (phase === 'leading') {
      const open = OPEN.exec(buffer);
      if (open && buffer.slice(0, open.index).trim() === '') {
        buffer = buffer.slice(open.index + open[0].length);
        phase = 'narrating';
      } else if (buffer.trim() === '' || (!open && buffer.trimStart().startsWith('<') && buffer.length < LONGEST_TAG)) {
        carry = buffer; // could still become an opening tag
        return '';
      } else {
        phase = 'passthrough';
      }
    }

    if (phase === 'narrating') {
      const close = CLOSE.exec(buffer);
      if (!close) {
        const cut = buffer.lastIndexOf('<');
        carry = cut >= 0 && buffer.length - cut <= LONGEST_TAG ? buffer.slice(cut) : '';
        return '';
      }
      buffer = buffer.slice(close.index + close[0].length);
      phase = 'passthrough';
    }

    return buffer;
  };
}

/** Removes a reasoning model's narration, leaving the answer it was working towards. */
export function withoutReasoning(text: string): string {
  return text.replace(THINK_BLOCK, ' ').replace(THINK_UNCLOSED, ' ').trim();
}

export function extractSql(text: string): Extraction | null {
  const raw = withoutReasoning(text ?? '');

  // 1) Fenced blocks - first block that looks like a query wins.
  const fences = [...raw.matchAll(FENCE_RE)];
  for (const f of fences) {
    const candidate = (f[1] ?? '').trim();
    if (candidate && SQL_START_RE.test(candidate)) {
      const explanation = raw.replace(f[0]!, ' ').replace(/```[\s\S]*?```/gu, ' ');
      return { sql: candidate, explanation: tidy(explanation), source: 'fence' };
    }
  }

  // 2) Whole message is SQL.
  const trimmed = raw.trim();
  if (SQL_START_RE.test(trimmed)) {
    return { sql: trimmed, explanation: '', source: 'whole' };
  }

  // 3) Inline: first SELECT/WITH run up to a blank line or end.
  const inline = INLINE_START_RE.exec(raw);
  if (inline) {
    const sql = inline[1]!.trim();
    if (sql.length > 8) {
      return { sql, explanation: tidy(raw.replace(inline[1]!, ' ')), source: 'inline' };
    }
  }
  return null;
}

/** A hedging "IMPOSSIBLE:" line. The query wins (see extractSql), so the hedge must not travel with it. */
const SENTINEL_LINE = /^[^\S\n]*IMPOSSIBLE\b[^\n]*$/gimu;

// Normalize whitespace; no length cap - the description stays complete.
function tidy(explanation: string): string {
  return explanation.replace(SENTINEL_LINE, ' ').replace(SENTINEL_WORD, '').replace(/\s+/gu, ' ').trim();
}
