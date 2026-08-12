/**
 * Lightweight, deterministic schema matching used by the repair loop: detecting
 * structure ("show tables") questions, the per-dialect catalog-listing query, and
 * fuzzy table-name matching for a likely misspelling. No model calls.
 */

import { isCapabilityQuestion } from './scope.js';
import type { EngineKind, SchemaCatalog } from './types.js';

/** Questions about the database's own structure rather than its rows. */
const METADATA_INTENT =
  /\b(show|list|display|describe|enumerate|count|name|get|give|tell|see|view|what(?:'s| is| are)?|which|how many|do (?:you|we) have|are there|exist)\b/i;
const METADATA_OBJECT =
  /\b(tables?|collections?|columns?|fields?|schemas?|views?|indexes|indices|relationships?|foreign keys?|primary keys?|constraints?|triggers?|procedures?|functions?|routines?|sequences?|partitions?|(?:database|db|data) (?:structure|layout|schema))\b/i;

/** Asking about the database rather than for data from it; none of these has an answer in rows. */
const ADVICE_INTENT =
  /\b(improv\w*|optimi[sz]\w*|tun(?:e|ing)|speed(?:\s*up)?|normali[sz]\w*|denormali[sz]\w*|redesign\w*|refactor\w*|restructur\w*|(?<!\b(?:the|its|all|these|those|many|few|no|some) )partition\w*|(?<!\b(?:the|its|all|these|those|many|few|no|some) )shard\w*|archiv(?:e|es|ed|ing|al)\b(?!\s*(?:table|log|collection|folder))|rewrit\w*|review\b(?!\s*(?:table|collection|log|queue))|audit\b(?!\s*(?:log|table|trail|history))|help(?:s|ing)?\b(?!\s+me\b)|critique|suggest\w*|recommend\w*|advice|advise|feedback\b(?!\s*(?:table|collection|form|data|survey))|thoughts?|opinion|best(?:\s+\w+)?\s+(?:way|practice|practices|approach|option|design|choice|strategy|structure|format|type|index|indexes|schema)\b|better\b|faster|quicker|(?:this|it|that|everything|(?:the|my|our|these)\s+(?:\w+\s+)?(?:quer(?:y|ies)|report|dashboard|page|joins?|views?|indexe?s?|tables?|schema|database|thing))(?:\s+(?:on|in|for|between|against|over|with|from)\b[\w\s]{0,24}?)?\s+(?:is|are|was|were|runs?|running|feels?|seems?)\s+(?:so |very |really |too )?slow\w*|forever|bad\b|poor\b|terrible|killing|worth (?:it|doing|the)\b|reduc\w*|wrong with|should (?:i|there|this|it)|i should|do you (?:think|see)|do i need|what needs|(?:what )?would you (?:change|do|suggest|recommend|normali[sz]e|denormali[sz]e|add|drop|split|merge|index|partition)|relate[sd]\b|grow\w*|scal(?:e|es|ing|ability)\b|model(?:l?ed|l?ing)\b|needs? (?:to be )?(?:updated?|changed?|fixed?|added?)|problems?|issues? (?:with|in|around)\b|mistakes?|redundant(?=\s+(?:index(?:es)?|indices|columns?|tables?|joins?|constraints?|keys?|data)\b)|unused\s+(?:index(?:es)?|indices|column|columns|table|tables|constraints?|keys?|fields?)\b|unnecessary(?=\s+(?:index(?:es)?|indices|columns?|tables?|joins?|constraints?|keys?)\b)|(?:missing|duplicate)\w*[^.?!]{0,20}\b(?:index(?:es)?|indices|constraints?|keys?|relationships?)|too many|too few|make[s]? sense|properly|correctly|the right way|is (?:this|it|that|my|our)[^.?!]{0,24}\bok(?:ay)?\b|sensible|reasonable|why (?:is|are|am|does|do|did|would)|what does .{0,30}do\b|explain|break down|convert|translate|port\b|migrat\w*|difference between|when should|pros and cons|document(?:s|ing)?\s+(?:the|this|my|our)\b|trade-?offs?|(?:take a )?look at\s+(?:my|the|this|our)\s+(?:schema|database|db|design|data ?model)\b|say about)\b/i;

/** What advice is asked about. Wider than [METADATA_OBJECT]: performance, query text and errors count too. */
const ADVICE_OBJECT =
  /\b(tables?|collections?|columns?|fields?|schemas?|views?|index(?:es|ing|ed)?|indices|relationships?|relations?|foreign keys?|primary keys?|constraints?|triggers?|procedures?|functions?|routines?|sequences?|joins?|partition\w*|shard\w*|embed\w*|documents?|model(?:s|l?ed|l?ing)?\b|quer(?:y|ies)|sql|ddl|statements?|syntax|performance|slow\w*|latency|throughput|rows?|duplicates?|normali[sz]\w*|denormali[sz]\w*|databases?|dbs?|design|structures?|reports?|dashboards?|data ?model\w*|postgres\w*|mysql|mariadb|sqlite|oracle|mongo\w*|duckdb|(?:database|db|data) (?:structure|layout|schema|design|model))\b/i;

/** A structure question answerable by a catalog listing. Advice is excluded so the repair loop does not offer one. */
export function isMetadataQuestion(question: string): boolean {
  return (
    METADATA_INTENT.test(question) &&
    METADATA_OBJECT.test(question) &&
    !isSchemaAdviceQuestion(question) &&
    !isDatabaseOverviewQuestion(question)
  );
}

/** Advice whose intent already names its object, so the non-overlapping rule cannot apply. */
const SELF_CONTAINED_ADVICE =
  /\b(?:unused|redundant|unnecessary)\s+(?:index(?:es)?|indices|constraints?|keys?|relationships?|columns?|tables?|fields?)\b|\b(?:missing|duplicate)\s+(?:index(?:es)?|indices|constraints?|foreign keys?|primary keys?|relationships?)\b|\bbest\s+(?:practices?|approach|design|strategy)\b|\bbest\s+way\s+to\s+(?:store|model|structure|organi[sz]e|handle|represent|index|partition|split|name|design|track)\b|\b(?:what|which)\b[^.?!]{0,30}\b(?:changes?|improvements?|optimi[sz]ations?)\b[^.?!]{0,25}\b(?:needed|required|necessary|recommend\w*|suggest\w*|apply)\b|\b(?:what|which)\s+(?:changes?|improvements?|optimi[sz]ations?)\b[^.?!]{0,20}\bshould\b/i;

/** Advice that names no object because the object is the query in front of the user. */
const BARE_ADVICE =
  /\b(?:what (?:do|should) i do|what now|how do i fix (?:this|it)|any (?:ideas|suggestions)|is it worth\b|(?:this|it|that) (?:is|was|runs?|feels?|seems?) (?:so |very |really |too )?slow|why (?:is|are|does|do|did)\b[\w\s]{0,30}?\b(?:grow\w*|so (?:big|large|slow|fast)))\b/i;

/** Every span the pattern matches, so the two halves of an advice question can be told apart. */
function matchSpans(re: RegExp, question: string): readonly (readonly [number, number])[] {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const out: [number, number][] = [];
  for (const m of question.matchAll(global)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * True when the question asks for an opinion about the schema or a query rather than for data.
 * The intent and the object have to be NON-OVERLAPPING words.
 */
export function isSchemaAdviceQuestion(question: string): boolean {
  if (BARE_ADVICE.test(question) || SELF_CONTAINED_ADVICE.test(question)) return true;
  const intents = matchSpans(ADVICE_INTENT, question);
  if (intents.length === 0) return false;
  // A question frame ("what does this query do") carries its own meaning.
  if (intents.some(([s, e]) => question.slice(s, e).trim().split(/\s+/).length >= 3)) return true;
  const objects = matchSpans(ADVICE_OBJECT, question);
  return objects.some(([os, oe]) => intents.some(([is, ie]) => oe <= is || os >= ie));
}

/** Asking what the database *is*, not what is in it: the answer is a description, not a table list. */
const OVERVIEW_INTENT =
  /\b(describe|description|detail|details|overview|summar\w*|explain|walk me through|tell me about|understand|introduce|high[- ]level|brief|contain\w*|what(?:'s| is) in|what(?:'s| is) (?:this|the|your)[^.?!]{0,24}\bfor\b|hold\w*)\b/i;
/** The whole database, not one named table - "describe the orders table" is still a column listing. */
const OVERVIEW_OBJECT =
  /\b(schemas?|databases?|db|data ?model\w*|structure|layout|(?:files?|spreadsheets?|csvs?|workbooks?)(?!\s+(?:table|collection)))\b/i;

/** Advice asking what to CHANGE, not describing what is there; only the former makes a new name a proposal. */
const PRESCRIPTIVE_ADVICE =
  /\b(improv\w*|optimi[sz]\w*|tun(?:e|ing)|speed(?:\s*up)?|normali[sz]\w*|denormali[sz]\w*|redesign\w*|refactor\w*|restructur\w*|(?<!\b(?:the|its|all|these|those|many|few|no|some) )partition\w*|(?<!\b(?:the|its|all|these|those|many|few|no|some) )shard\w*|archiv(?:e|es|ed|ing|al)\b(?!\s*(?:table|log|collection|folder))|rewrit\w*|suggest\w*|recommend\w*|advice|advise|should i|(?:what )?would you (?:change|do|suggest|recommend|normali[sz]e|denormali[sz]e|add|drop|split|merge|index|partition)|missing|add\b|better\b|best\b|reduc\w*|fix\w*|what needs)\b/i;

/** True when an unknown name in the answer is a proposal AskSQL never runs, rather than a hallucination. */
export function isSchemaProposalQuestion(question: string): boolean {
  return isSchemaAdviceQuestion(question) && PRESCRIPTIVE_ADVICE.test(question);
}

/** "the reporting structure of employees" is a question about rows in a table, not about the database. */
const STRUCTURE_OF_TABLE =
  /\b(?:structure|layout)\s+(?:of|in|for)\s+(?:the |this |that |our |my )?(?!databases?\b|db\b|schemas?\b|data ?model)\w/i;

/** True when the question asks for a description of the database as a whole, not a catalog listing. */
export function isDatabaseOverviewQuestion(question: string): boolean {
  if (STRUCTURE_OF_TABLE.test(question) && !/\b(?:schemas?|databases?|db|data ?model)\b/i.test(question)) return false;
  return OVERVIEW_INTENT.test(question) && OVERVIEW_OBJECT.test(question);
}

/** "write/give me a statement that deletes ..." - the write verb has to come AFTER the noun. */
const WRITE_REQUEST =
  // An imperative opening is a write request even with no "statement"/"query" noun: "delete all
  // cancelled orders" is the commonest phrasing there is, and answering it with a SELECT is silent.
  /^\s*(?:(?:please|now|ok|okay|so)\s+|(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?|i\s+(?:want|need)\s+(?:you\s+)?to\s+|go ahead and\s+|let'?s\s+)*(?:(?:delete|truncate|erase|purge|wipe|nuke|remove(?!\s+duplicates?\b))\b|(?:drop(?!\s+(?:rows?|records?|duplicates?|nulls?)\b)|insert|update|alter|rename|clear|empty|flush)\b[^.?!]{0,60}\b(?:table|column|row|rows|record|records|from|into|set|every|all|the|this|my|our)\b)|\b(?:write|create|give|show|generate|produce|draft|compose|need|want|how (?:do|can|would) i)\b[^.?!]{0,60}\b(?:statement|query|sql|ddl|command|script|migration)\b[^.?!]{0,60}\b(?:insert|inserts|inserting|update|updates|updating|delete|deletes|deleting|drop|drops(?!\s+(?:rows?|records?|duplicates?|nulls?)\b)|dropping|truncate|truncates|truncating|alter|alters|altering|remove|removes(?!\s+duplicates?\b)|removing|rename|renames|renaming|wipes?|wiping|purges?|purging|erases?|erasing|clears?|clearing|empties|emptying|flushes?|flushing|add\b[^.?!]{0,24}\b(?:column|index|constraint|table|field|foreign key))\b|\b(?:write|create|give|show|generate|produce|draft|compose|need|want)\b[^.?!]{0,30}\b(?:insert|update|delete|drop|truncate|alter|rename|merge|upsert)\s+(?:statement|query|sql|ddl|command|script|migration)\b|\b(?:write|create|give|show|generate|produce|draft|compose|need|want)\b[^.?!]{0,20}\b(?:insert|update|delete|drop|truncate|alter|merge|upsert)\b\s+(?:that|to|which|for|removing|adding|setting)\b|\b(?:statement|query|sql|ddl|command|script|migration)\b[^.?!]{0,40}\b(?:that|to|which)\b[^.?!]{0,40}\b(?:insert|inserts|update|updates|delete|deletes|drop|drops(?!\s+(?:rows?|records?|duplicates?|nulls?)\b)|truncate|truncates|alter|alters|remove|removes(?!\s+duplicates?\b)|rename|renames|wipes?|purges?|erases?|clears?|empties|flushes?|add\b[^.?!]{0,24}\b(?:column|index|constraint|table|field|foreign key))\b/i;

/** True when the user wants a write statement handed to them; a capability question is not one. */
export function isWriteRequest(question: string): boolean {
  return WRITE_REQUEST.test(question) && !isCapabilityQuestion(question);
}

/** "run that query", "show me those results": the user means the query they just read, not a new one. */
const RERUN_PREVIOUS =
  /^\s*(?:(?:please|now|ok|okay|yes)\s+|(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?)*(?:re-?)?(?:run|execute|show(?:\s+me)?|give(?:\s+me)?|display)\b[^.?!]{0,40}\b(?:this|that|the\s+(?:previous|last|above|same|first|second|aggregation|aggregate))\b[^.?!]{0,40}$/i;

/** True when the question asks to run a query already shown, rather than for a new one. */
export function isRerunPreviousRequest(question: string): boolean {
  return RERUN_PREVIOUS.test(question);
}

/** Each engine's read-only way to list tables; system schemas are exempt from the hallucination floor. */
export function catalogQueryHint(engine: EngineKind): string {
  switch (engine) {
    case 'sqlite':
      return "SELECT name, type FROM sqlite_master WHERE type IN ('table','view')";
    case 'mysql':
      return 'SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE()';
    case 'oracle':
      return 'SELECT table_name FROM all_tables';
    default:
      return "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')";
  }
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j - 1]!, dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}

/** A real table name that's a likely misspelling of a question word, so a refusal can retry with the real name. */
export function closestTableName(question: string, catalog: SchemaCatalog): string | null {
  const words = new Set(question.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const word of words)
    for (const table of catalog.tables) {
      const name = table.name.toLowerCase();
      if (name === word) continue;
      const threshold = Math.max(1, Math.floor(Math.min(word.length, name.length) / 4));
      const distance = levenshtein(word, name);
      if (distance <= threshold && distance < bestDistance) {
        bestDistance = distance;
        best = table.name;
      }
    }
  return best;
}
