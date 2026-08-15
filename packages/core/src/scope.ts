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

export function isOffTopic(answer: string): boolean {
  const trimmed = answer.trim();
  // A reply that OPENS with the marker is a refusal however much the model then rambles.
  if (new RegExp(`^\\W{0,3}(?:${SENTINEL_BODY}|${SENTINEL_SPACED})\\b`).test(trimmed)) return true;
  if (new RegExp(`^\\W{0,3}${SENTINEL_BODY}\\b`, 'i').test(trimmed)) return true;
  if (trimmed.length > OFF_TOPIC_MAX_REPLY_LENGTH) return false;
  if (OFF_TOPIC_RE.test(trimmed)) return true;
  // Any casing counts only when the sentinel IS the whole reply; mid-sentence it is English.
  return new RegExp(`^\\W*${SENTINEL_BODY}\\W*$`, 'i').test(trimmed);
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

/**
 * Database vocabulary in the question itself; a refusal is challenged once when the question plainly
 * IS about data.
 *
 * Two tiers, because half of these words are ordinary English. "data", "key", "record", "index" and
 * "role" carried the same weight as "foreign key", so "what is the weather data for tomorrow" was
 * treated as a question about this database and the model's correct refusal was overridden.
 */
const STRONG_VOCABULARY_RE =
  /\b(database|databases|db|dbs|dbms|rdbms|table|tables|column|columns|schema|schemas|catalog|sql|query|queries|statement|statements|subquery|cte|select|insert|update|delete|drop|alter|truncate|merge|upsert|join|joins|inner join|outer join|group by|order by|having|where clause|window function|aggregate|aggregation|pipeline|indexes|indices|primary key|foreign key|unique|constraint|constraints|trigger|triggers|materialized view|procedure|procedures|routine|routines|sequence|sequences|partition|partitions|partitioning|shard|sharding|replica|replication|tablespace|cursor|transaction|transactions|commit|rollback|isolation|deadlock|vacuum|cardinality|selectivity|explain|query plan|execution plan|normali[sz]\w*|denormali[sz]\w*|migration|migrations|migrate|autoincrement|datatype|data type|varchar|integer|bigint|numeric|decimal|boolean|timestamp|datetime|blob|clob|jsonb|uuid|nullable|erd|bson|objectid|collection|collections|document|documents|postgres|postgresql|pgsql|mysql|mariadb|oracle|plsql|sqlite|duckdb|mongo|mongodb|redis|mssql|sql server|sqlserver|snowflake|bigquery|redshift|clickhouse|cockroach|timescale|supabase|planetscale|nosql|olap|oltp|orm|etl|elt|warehouse|data ?lake|dataset|read replica)\b/iu;

/** The ambiguous half, which counts only inside a phrase that is unmistakably about a database. */
const WEAK_IN_CONTEXT_RE =
  /\b(?:primary|foreign|unique|composite|surrogate|natural|candidate|partition)\s+keys?\b|\bkeys?\s+(?:constraint|violation|column)\b|\b(?:create|drop|add|rebuild|missing|unused|covering|clustered|partial|composite)\s+index(?:es)?\b|\bindex(?:es|ing)?\s+(?:on|for|scan|seek|usage|strategy)\b|\bdata\s+(?:type|types|model|modelling|modeling|warehouse|lake|set|sets|base|integrity|quality)\b|\b(?:row|rows|record|records|field|fields)\s+(?:in|from|of|per|with|where|count|returned)\b|\b(?:how many|number of|count of|total)\s+(?:rows|records|fields|columns)\b|\b(?:materiali[sz]ed|create|drop|define)\s+views?\b|\bviews?\s+(?:definition|named|on)\b|\bnulls?\s+(?:values?|constraint)\b|\b(?:is|not)\s+null\b|\bstatistics\s+(?:on|for)\s+(?:the\s+|this\s+|a\s+)?(?:table|tables|column|columns|index|indexes|query|queries|database|db|schema)\b|\b(?:grant|revoke)\s+(?:role|privilege)|\broles?\s+(?:privileges?|permissions?|grants?)\b|\block(?:s|ing)?\s+(?:contention|timeout|wait|table|escalation)\b|\bcluster(?:ed)?\s+(?:index|key|by)\b|\bfunctions?\s+(?:in|on)\s+(?:postgres|postgresql|mysql|oracle|sqlite|duckdb|mongo|sql)\b|\bstored\s+(?:function|procedure)s?\b|\brelationships?\s+between\b|\b(?:entity|entities)\s+(?:relationship|model)\b|\bbackup\s+(?:and|the|my|this)\s+(?:restore|database|db|data)\b|\bdump\s+the\s+(?:database|db|table|schema)\b/iu;

export function looksDatabaseRelated(question: string): boolean {
  return STRONG_VOCABULARY_RE.test(question) || WEAK_IN_CONTEXT_RE.test(question);
}

/**
 * A third-person singular pronoun with nothing to bind it to. "What role did he play in the film?"
 * names no one, so the model picks a subject itself and answers confidently about the wrong person.
 *
 * Third-person singular only: "their" is ordinary in "customers and their orders", and "it"/"they"
 * carry too much other work. A capitalised word earlier in the question is treated as the antecedent,
 * and prior turns bind it too, so this is silent on follow-ups.
 */
const UNBOUND_PRONOUN_RE = /\b(he|him|his|she|her|hers)\b/iu;

export function danglingReference(question: string, hasContext: boolean): string | null {
  if (hasContext) return null;
  const match = UNBOUND_PRONOUN_RE.exec(question);
  if (!match) return null;
  const before = question.slice(0, match.index);
  // A proper noun earlier in the sentence is the antecedent; the first word is just capitalisation.
  if (/\s\p{Lu}/u.test(before)) return null;
  return match[1]!.toLowerCase();
}

/** Attempts to talk past the instructions rather than ask a question; declined in code, never by the model. */
const NOT_MY_INSTRUCTIONS = String.raw`(?!\s+(?:table|collection|column|field|view|list|entry|entries|row|rows))`;
/** Determiners stack freely: "ignore all the previous instructions" is one slot per word, not one. */
const INJECTION_DETERMINERS = String.raw`(?:(?:all|any|the|your|our|my|these|those)\s+)*`;
const INJECTION_QUALIFIERS = String.raw`(?:(?:previous|prior|earlier|above|preceding|system|initial|original)\s+)?`;

const PROMPT_INJECTION_RE = new RegExp(
  [
    // Countermanding the instructions, in any determiner/qualifier combination.
    String.raw`\b(?:ignore|disregard|forget|override|discard)\s+${INJECTION_DETERMINERS}${INJECTION_QUALIFIERS}(?:instructions?|prompts?|rules?)\b${NOT_MY_INSTRUCTIONS}`,
    // Asking for the instructions themselves. "the instructions" alone is not enough: a table can be
    // called that, and "show me the instructions for order 42" is an ordinary data question.
    String.raw`\b(?:print|reveal|show|repeat|output|tell|give)\s+(?:me\s+)?(?:your\s+${INJECTION_QUALIFIERS}(?:prompt|instructions)|the\s+(?:system|initial|original)\s+(?:prompt|instructions))\b${NOT_MY_INSTRUCTIONS}`,
    String.raw`\bwhat\s+(?:is|are|were)\s+your\s+(?:system\s+)?(?:prompt|instructions|rules)\b`,
    // Replacing the instructions or the role.
    String.raw`\byour\s+new\s+(?:instructions?|prompts?|rules?)\b`,
    String.raw`\b(?:from\s+now\s+on,?\s+)?you\s+are\s+now\s+(?:a|an|no\s+longer)\b`,
    String.raw`\bfrom\s+now\s+on,?\s+you\s+(?:are|will|must)\b`,
    String.raw`\bpretend\s+(?:to\s+be|you\s+are)\b`,
    String.raw`\bact\s+as\s+(?:if|though)\s+you\b`,
  ].join('|'),
  'i',
);

export function isPromptInjection(question: string): boolean {
  return PROMPT_INJECTION_RE.test(question);
}

/** Questions about AskSQL itself ("can you delete my data?"), answered in code and never by the model. */
const CAPABILITY_RE = new RegExp(
  [
    // What it is. The boundary matters: "who are your top customers" is a data question.
    String.raw`\b(?:what can you do|what do you do|what are you|who are you|how do you work)\b`,
    String.raw`\bwhat is asksql\b`,
    String.raw`\b(?:is asksql|are you|is (?:this|it)) (?:safe|read[- ]?only)\b`,
    // Whether it can write. The object has to END the question: once it carries a qualifier
    // ("delete the rows WHERE status is cancelled") it is a concrete request, not a question about
    // AskSQL, and belongs on the write path.
    String.raw`\b(?:can|could|will|would|do|does|are you able to|is it able to)\s+(?:you\s+|it\s+|asksql\s+)?(?:ever\s+)?` +
      String.raw`(?:delete|drop|update|insert|modify|change|write|edit|alter|remove)\s+(?:to\s+)?(?:my\s+|the\s+|any\s+|our\s+)?` +
      String.raw`(?:data|database|db|records?|rows?|tables?|schema|anything|something|things|it|this|that)(?:\s+(?:tables?|records?|rows?|data))?` +
      // A generic tail keeps it a question about AskSQL; a concrete one (a WHERE clause, a named
      // table) makes it a real request, which belongs on the write-proposal path instead.
      String.raw`(?:\s+(?:please|thanks|thank you|ever|at all|for me|or not|in any way|(?:from|in|on)\s+(?:the\s+|my\s+|our\s+)?(?:database|db|schema|tables?)))*\s*[?.!]*\s*$`,
    // Same question with AskSQL or the tool as the subject rather than "you".
    String.raw`\b(?:will|does|can|could)\s+(?:this|that|it|asksql)\s+(?:ever\s+)?(?:change|modify|alter|affect|delete|update|write to|touch)\s+(?:my\s+|the\s+|any\s+|our\s+)?(?:data|database|db|records?|rows?|tables?|schema|anything|something)\b`,
    // Privacy: asked as often as the write question, and a model must not answer it.
    String.raw`\bis my data safe\b`,
    String.raw`\b(?:do|does|will)\s+(?:you|it|asksql)\s+(?:store|keep|save|retain|send|share|upload|log)\s+(?:my|our|the)\s+(?:data|queries|questions|schema|results)\b`,
    String.raw`\bwhere\s+(?:does|do)\s+(?:my|our)\s+(?:data|queries)\s+go\b`,
  ].join('|'),
  'i',
);

export function isCapabilityQuestion(question: string): boolean {
  return CAPABILITY_RE.test(question);
}

/** The honest answer about what AskSQL does, written in code so it is always accurate. */
export function capabilityAnswer(dialectLabel: string): SchemaAnswer {
  return {
    answer:
      `I turn your questions into read-only SQL for this ${dialectLabel} database, show you the query for every answer, ` +
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
