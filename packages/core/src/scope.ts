/**
 * What AskSQL will and will not answer, and the shape of a schema answer. Free of engine imports:
 * reaching into `engine.ts` would pull the SQL parser into every browser bundle that only speaks
 * MongoDB.
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
  /**
   * The read-only query this answer suggested, if it suggested one. Carry it into the next turn's
   * context so "run that query" means the query the user just read. Absent for a write proposal.
   */
  readonly proposedSql?: string;
}

/** A refusal is the WHOLE reply, so only a reply this short counts as the off-topic sentinel. */
const OFF_TOPIC_MAX_REPLY_LENGTH = 120;

/** Models reformat the sentinel ("OUT OF SCOPE", "out-of-scope", "**OUT_OF_SCOPE**"); any separator counts. */
const SENTINEL_BODY = OFF_TOPIC_SENTINEL.split('_').join('[_-]');
const SENTINEL_SPACED = OFF_TOPIC_SENTINEL.split('_').join('\\s');
// Punctuated forms are never prose, so case is ignored; the spaced form must be capitals.
const OFF_TOPIC_RE = new RegExp(`(^|\\W)(?:${SENTINEL_BODY}|${SENTINEL_SPACED})(\\W|$)`, '');
const OFF_TOPIC_CI_RE = new RegExp(`(^|\\W)${SENTINEL_BODY}(\\W|$)`, 'i');

export function isOffTopic(answer: string): boolean {
  const trimmed = answer.trim();
  // A reply that OPENS with the marker is a refusal however much the model then rambles.
  if (new RegExp(`^\\W{0,3}(?:${SENTINEL_BODY}|${SENTINEL_SPACED})\\b`).test(trimmed)) return true;
  if (new RegExp(`^\\W{0,3}${SENTINEL_BODY}\\b`, 'i').test(trimmed)) return true;
  if (trimmed.length > OFF_TOPIC_MAX_REPLY_LENGTH) return false;
  return OFF_TOPIC_RE.test(trimmed) || OFF_TOPIC_CI_RE.test(trimmed);
}

/** Remove a sentinel the model bolted onto a real answer; returns the cleaned text. */
const OFF_TOPIC_GLOBAL_RE = new RegExp(`(^|\\W)(?:${SENTINEL_BODY}|${SENTINEL_SPACED})(\\W|$)`, 'g');
const OFF_TOPIC_GLOBAL_CI_RE = new RegExp(`(^|\\W)${SENTINEL_BODY}(\\W|$)`, 'gi');

export function stripSentinel(answer: string): string {
  const stripped = answer.replace(OFF_TOPIC_GLOBAL_RE, ' ').replace(OFF_TOPIC_GLOBAL_CI_RE, ' ');
  if (stripped === answer) return answer;
  return stripped.replace(/[ \t]{2,}/g, ' ').trim();
}

/** A model declining in prose rather than answering. Shared by the ask loop and the scope guard. */
// Both apostrophes: models emit U+2019 as often as U+0027.
export const MODEL_REFUSAL_RE = /\b(i can(?:no|['’])t|i cannot|i am unable|i['’]m unable|i['’]m sorry|as an ai)\b/iu;

/** A reply that is ONLY a refusal; length-bounded like [isOffTopic]. */
const PROSE_REFUSAL_MAX_LENGTH = 400;

export function isProseRefusal(answer: string, mentionsSchema = false): boolean {
  // An answer that names a real table or column is an ANSWER, however it is worded.
  if (mentionsSchema) return false;
  const trimmed = answer.trim();
  return trimmed.length <= PROSE_REFUSAL_MAX_LENGTH && MODEL_REFUSAL_RE.test(trimmed);
}

/** A reply that is not an explanation at all: a couple of words, or no prose in it. */
export function isDegenerateAnswer(answer: string): boolean {
  const trimmed = answer.trim();
  if (trimmed.length >= 60) return false;
  // Chinese, Japanese and Korean do not space words, so a whole sentence scores as one; judge by length.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed)) {
    return trimmed.length < 8;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  // Lowercase letters in ANY script, so Cyrillic or Greek prose is not rejected as a shouty fragment.
  return words.length < 4 || !/\p{Ll}{3}/u.test(trimmed);
}

/** Database vocabulary in the question itself; a refusal is challenged once when the question plainly IS about data. */
const DATABASE_VOCABULARY_RE =
  /\b(database|databases|db|dbs|dbms|rdbms|table|tables|column|columns|field|fields|row|rows|record|records|schema|schemas|catalog|sql|query|queries|statement|statements|subquery|cte|select|insert|update|delete|drop|alter|truncate|merge|upsert|join|joins|inner join|outer join|group by|order by|having|where clause|window function|aggregate|aggregation|pipeline|index|indexes|indices|indexing|key|keys|primary key|foreign key|unique|constraint|constraints|trigger|triggers|view|views|materialized view|procedure|procedures|routine|routines|(?<!\b(?:python|javascript|typescript|java|ruby|rust|php|kotlin|swift|scala|perl|bash|shell|golang) )functions?|sequence|sequences|partition|partitions|partitioning|shard|sharding|replica|replication|cluster|tablespace|cursor|transaction|transactions|commit|rollback|isolation|lock|locks|locking|deadlock|vacuum|analyze|statistics|cardinality|selectivity|explain|query plan|execution plan|normali[sz]\w*|denormali[sz]\w*|migration|migrations|migrate|backup|restore|dump|seed|fixture|grant|revoke|privilege|privileges|permission|permissions|role|roles|autoincrement|identity|serial|datatype|data type|varchar|integer|bigint|numeric|decimal|boolean|timestamp|datetime|blob|clob|json|jsonb|uuid|null|nulls|nullable|duplicate|duplicates|relation|relations|relationship|relationships|entity|entities|erd|collection|collections|document|documents|bson|objectid|postgres|postgresql|pgsql|mysql|mariadb|oracle|plsql|sqlite|duckdb|mongo|mongodb|redis|mssql|sql server|sqlserver|snowflake|bigquery|redshift|clickhouse|cockroach|timescale|supabase|planetscale|nosql|olap|oltp|orm|etl|elt|warehouse|data ?lake|data|dataset|latency|throughput|read replica)\b/iu;

export function looksDatabaseRelated(question: string): boolean {
  return DATABASE_VOCABULARY_RE.test(question);
}

/** Attempts to talk past the instructions rather than ask a question; declined in code, never by the model. */
const PROMPT_INJECTION_RE =
  /\b(?:ignore (?:all |any )?(?:previous|prior|earlier|above|the|your|these|those) (?:instructions|prompts?|rules)\b(?!\s+(?:table|collection|column|field|view|list|entry|entries|row|rows))|disregard (?:all |any )?(?:the |your )?(?:previous|prior|earlier|above|system) (?:instructions|prompts?|rules)\b(?!\s+(?:table|collection|column|field|view|list|entry|entries|row|rows))|(?:print|reveal|show|repeat|output|tell me) (?:me )?(?:your|the) (?:system |initial |original )?(?:prompt|instructions)\b(?!\s+(?:table|collection|column|field|view|list|entry|entries|row|rows))|what (?:is|are|were) your (?:system )?(?:prompt|instructions|rules)|you are now (?:a|an|no longer)|pretend (?:to be|you are)|act as (?:if|though) you)/i;

export function isPromptInjection(question: string): boolean {
  return PROMPT_INJECTION_RE.test(question);
}

/** Questions about AskSQL itself ("can you delete my data?"), answered in code and never by the model. */
const CAPABILITY_RE =
  /\b(?:what can you do|what do you do|what are you|who are you|how do you work|what is asksql|is asksql (?:safe|read[- ]?only)|are you (?:safe|read[- ]?only)|is (?:this|it) (?:safe|read[- ]?only)|(?:can|could|will|would|do|does|are you able to|is it able to)\s+(?:you\s+|it\s+)?(?:ever\s+)?(?:delete|drop|update|insert|modify|change|write|edit|alter|remove)\s+(?:to\s+)?(?:my\s+|the\s+|any\s+|our\s+)?(?:data|database|db|records?|rows?|tables?|schema|anything|something|things)\b)/i;

export function isCapabilityQuestion(question: string): boolean {
  return CAPABILITY_RE.test(question);
}

/** The honest answer about what AskSQL does, written in code so it is always accurate. */
export function capabilityAnswer(dialectLabel: string): SchemaAnswer {
  return {
    answer:
      `I turn your questions into read-only SQL for this ${dialectLabel} database, show you the query before it runs, ` +
      'and explain the result.\n\n' +
      'I never change your data. Every statement is checked before it reaches the database and anything that is not a ' +
      'read-only query is refused - that check is code, not a prompt, so it holds regardless of what the AI replies. ' +
      'If you ask for an INSERT, UPDATE, DELETE or a schema change, I write the statement out for you to run yourself ' +
      'and never run it.\n\n' +
      'I can also answer questions about the database itself: what it holds, how the tables relate, what to index, and ' +
      'how to improve the design.',
    tables: [],
    grounded: true,
    unknownReferences: [],
    isSchemaChange: false,
  };
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
