/**
 * What AskSQL will and will not answer, and the shape of a schema answer.
 *
 * Deliberately free of engine imports: the MongoDB path needs these too, and reaching into
 * `engine.ts` for them would pull the SQL parser into every browser bundle that only ever
 * speaks MongoDB.
 */

import { OFF_TOPIC_SENTINEL } from './prompt.js';

export interface SchemaAnswer {
  readonly answer: string;
  /** Catalog tables given to the model as grounding (schema-qualified where applicable). */
  readonly tables: readonly string[];
  /** True unless the answer named a table/column not present in the schema. */
  readonly grounded: boolean;
  /** Identifier-shaped names in the answer absent from the schema. For a schema-change request these are proposed new names; otherwise they are hallucinations. */
  readonly unknownReferences: readonly string[];
  /** The question asked to add/change/remove schema objects, so unknownReferences are proposals AskSQL never runs, not errors. */
  readonly isSchemaChange: boolean;
}

/**
 * True when the model classified the question as nothing to do with data or databases.
 * A refusal is the WHOLE reply - models wrap the sentinel in punctuation or a short apology,
 * but never bury it in a real answer, so only a short reply counts. Matching it anywhere
 * would let an answer that happens to discuss the sentinel be replaced by the decline.
 */
const OFF_TOPIC_MAX_REPLY_LENGTH = 120;

/**
 * Models reformat the sentinel: "OUT OF SCOPE", "out-of-scope", "**OUT_OF_SCOPE**". Any
 * separator between the words counts, since an unmatched near-miss is rendered to the user as
 * the answer. The phrase is distinctive enough not to fire on prose within the length bound.
 */
const SENTINEL_BODY = OFF_TOPIC_SENTINEL.split('_').join('[_-]');
const SENTINEL_SPACED = OFF_TOPIC_SENTINEL.split('_').join('\\s');
// Punctuated forms are never prose, so case is ignored. The spaced form must be capitals:
// "that is out of scope for this schema" is ordinary English, not the marker.
const OFF_TOPIC_RE = new RegExp(`(^|\\W)(?:${SENTINEL_BODY}|${SENTINEL_SPACED})(\\W|$)`, '');
const OFF_TOPIC_CI_RE = new RegExp(`(^|\\W)${SENTINEL_BODY}(\\W|$)`, 'i');

export function isOffTopic(answer: string): boolean {
  const trimmed = answer.trim();
  // A reply that OPENS with the marker is a refusal however much the model then rambles;
  // only a marker buried later in a long reply is treated as an answer (and stripped).
  if (new RegExp(`^\\W{0,3}(?:${SENTINEL_BODY}|${SENTINEL_SPACED})\\b`).test(trimmed)) return true;
  if (new RegExp(`^\\W{0,3}${SENTINEL_BODY}\\b`, 'i').test(trimmed)) return true;
  if (trimmed.length > OFF_TOPIC_MAX_REPLY_LENGTH) return false;
  return OFF_TOPIC_RE.test(trimmed) || OFF_TOPIC_CI_RE.test(trimmed);
}

/**
 * Remove a sentinel the model bolted onto a real answer. Above the length bound the reply is
 * treated as an answer, but the marker is internal protocol and must never be shown - so it is
 * stripped rather than rendered. Returns the cleaned text (unchanged when there is no marker).
 */
const OFF_TOPIC_GLOBAL_RE = new RegExp(`(^|\\W)(?:${SENTINEL_BODY}|${SENTINEL_SPACED})(\\W|$)`, 'g');
const OFF_TOPIC_GLOBAL_CI_RE = new RegExp(`(^|\\W)${SENTINEL_BODY}(\\W|$)`, 'gi');

export function stripSentinel(answer: string): string {
  const stripped = answer.replace(OFF_TOPIC_GLOBAL_RE, ' ').replace(OFF_TOPIC_GLOBAL_CI_RE, ' ');
  if (stripped === answer) return answer;
  return stripped.replace(/[ \t]{2,}/g, ' ').trim();
}

/** A model declining in prose rather than answering. Shared by the ask loop and the scope guard. */
// Both apostrophes: models emit U+2019 as often as U+0027.
export const MODEL_REFUSAL_RE =
  /\b(i can(?:no|['’])t|i cannot|i am unable|i['’]m unable|i['’]m sorry|as an ai)\b/iu;

/**
 * A reply that is ONLY a refusal. Length-bounded for the same reason as [isOffTopic]: a real
 * schema answer may contain "I can't tell from the schema alone" and must not be thrown away.
 */
const PROSE_REFUSAL_MAX_LENGTH = 400;

export function isProseRefusal(answer: string, mentionsSchema = false): boolean {
  // An answer that names a real table or column is an ANSWER, however it is worded:
  // "I can't tell from the schema alone whether every order has a customer" is not a refusal.
  if (mentionsSchema) return false;
  const trimmed = answer.trim();
  return trimmed.length <= PROSE_REFUSAL_MAX_LENGTH && MODEL_REFUSAL_RE.test(trimmed);
}

/**
 * A reply that is not an explanation at all: a couple of words, or no prose in it. The prompt
 * asks for sentences, so a fragment is unusable however it arose - a small model can complete
 * the sentinel into a schema token it just read (an Oracle catalog holding OUT_ARGUMENT yields
 * "OUT_ARGUMENT VARCHAR2"). The honest reply for an unusable one is the scope decline.
 */
export function isDegenerateAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  if (trimmed.length >= 60) return false;
  // Chinese, Japanese and Korean do not put spaces between words, so a complete sentence
  // counts as one "word" and scored the same as a two-token fragment. Judge those by length.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed)) {
    return trimmed.length < 8;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  // Lowercase letters in ANY script, not just Latin: the point is to reject shouty catalog
  // fragments like "OUT_ARGUMENT VARCHAR2" without also rejecting Cyrillic or Greek prose.
  return words.length < 4 || !/\p{Ll}{3}/u.test(trimmed);
}

/**
 * Database vocabulary in the question itself. A small model calls anything naming another
 * product ("how would I do this in MongoDB?") off-topic, so its refusal is challenged once
 * when the question plainly IS about data.
 */
const DATABASE_VOCABULARY_RE =
  /\b(database|databases|db|dbs|table|tables|column|columns|row|rows|schema|schemas|sql|query|queries|select|insert|update|delete|drop|alter|truncate|join|joins|index|indexes|indices|key|keys|constraint|trigger|view|views|collection|collections|document|documents|aggregate|aggregation|pipeline|transaction|normalise|normalize|denormalise|denormalize|migration|migrate|partition|shard|replica|postgres|postgresql|mysql|mariadb|oracle|sqlite|duckdb|mongo|mongodb|redis|nosql|orm|etl|data|dataset|record|records)\b/iu;

export function looksDatabaseRelated(question: string): boolean {
  return DATABASE_VOCABULARY_RE.test(question);
}

/** The reply for an out-of-scope question, written here rather than left to the model. */
export function offTopicAnswer(dialectLabel: string): SchemaAnswer {
  return {
    answer:
      `I only help with databases - this connection is ${dialectLabel}. Ask me about its structure, ` +
      'a query over your data, or database topics in general (modelling, indexing, performance) and I am happy to help.',
    tables: [],
    grounded: true,
    unknownReferences: [],
    isSchemaChange: false,
  };
}
