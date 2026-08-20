package com.rahulmahadik.asksql.ide.engine

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.model.LimitStyle
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.db.JdbcExecutor
import com.rahulmahadik.asksql.ide.db.introspect.Introspectors
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.guard.SqlGuard
import com.rahulmahadik.asksql.ide.llm.LlmClient
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.Dialects
import com.rahulmahadik.asksql.ide.model.EngineEvent
import com.rahulmahadik.asksql.ide.model.EngineEventListener
import com.rahulmahadik.asksql.ide.model.GuardPolicy
import com.rahulmahadik.asksql.ide.model.GuardVerdict
import com.rahulmahadik.asksql.ide.model.SchemaCatalog
import com.rahulmahadik.asksql.ide.model.Stage
import com.rahulmahadik.asksql.ide.model.TableInfo
import com.rahulmahadik.asksql.ide.util.withHardTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap
import kotlin.time.Duration.Companion.seconds

/**
 * One pipeline for the whole plugin, keeping `@asksql/core`'s `engine.ts` invariants: guard every
 * SQL string before every execution, and never hold a DB connection open across an LLM call.
 */
class EnginePipeline(
    private val connectionRegistry: ConnectionRegistry,
    private val history: HistoryStore = InMemoryHistoryStore(),
    /** A `var`, not a `val`: a `maxRows` change must apply on the next question, so [com.rahulmahadik.asksql.ide.AskSqlEngineService] refreshes this on every access. */
    var policy: GuardPolicy = GuardPolicy.DEFAULT,
    /** Schema token budget, refreshed from settings on every access like [policy]. */
    var maxSchemaTokens: Int = CatalogPruner.PrunerSettings().maxSchemaTokens,
    /** Send example cell values to the model. Off by default: only the schema leaves the machine. */
    var allowDataInPrompt: Boolean = false,
) {
    companion object {
        private const val MAX_REPAIRS = 2

        /** Distinct values past this many mean a measurement, not a code. */
        private const val CODE_MAX_DISTINCT = 25
        private const val CODE_MAX_PROBES = 2
        private const val CODE_PROBE_TIMEOUT_MS = 1200L
        private val CATALOG_TTL = 300.seconds

        /** At most one staleness-driven re-read per connection in this window. */
        private const val STALE_REFRESH_COOLDOWN_MS = 30_000L

        /** A partially-failed introspection (warnings present) is cached only briefly. */
        private const val WARNED_CATALOG_TTL_MS = 30_000L
        private const val DEFAULT_QUERY_TIMEOUT_MS = 30_000L

        /** "SELECT 'canned reply' AS x" with no FROM - a model faking conversation as data. */
        private val LITERAL_STRING_ANSWER_RE = Regex(
            """^select\s+'(?:[^']|'')*'\s*(?:as\s+\w+)?\s*(?:limit\s+\d+)?\s*;?\s*$""",
            RegexOption.IGNORE_CASE,
        )

        /** Questions about the database's own structure rather than its rows. */
        private val METADATA_INTENT_RE = Regex(
            """\b(show|list|display|describe|enumerate|count|name|get|give|tell|see|view|what(?:'s| is| are)?|which|how many|do (?:you|we) have|are there|exist)\b""",
            RegexOption.IGNORE_CASE,
        )
        private val METADATA_OBJECT_RE = Regex(
            """\b(tables?|collections?|columns?|fields?|schemas?|views?|indexes|indices|relationships?|foreign keys?|primary keys?|constraints?|triggers?|procedures?|functions?|routines?|sequences?|partitions?|(?:database|db|data) (?:structure|layout|schema))\b""",
            RegexOption.IGNORE_CASE,
        )

        /** Asking about the database rather than for data from it: what to change, why it behaves so, how to express it. */
        private val ADVICE_INTENT_RE = Regex(
            """\b(improv\w*|optimi[sz]\w*|tun(?:e|ing)|speed(?:\s*up)?|normali[sz]\w*|denormali[sz]\w*|redesign\w*|refactor\w*|restructur\w*|(?<!\b(?:the|its|all|these|those|many|few|no|some) )partition\w*|(?<!\b(?:the|its|all|these|those|many|few|no|some) )shard\w*|archiv(?:e|es|ed|ing|al)\b(?!\s*(?:table|log|collection|folder))|rewrit\w*|review\b(?!\s*(?:table|collection|log|queue))|audit\b(?!\s*(?:log|table|trail|history))|help(?:s|ing)?\b(?!\s+me\b)|critique|suggest\w*|recommend\w*|advice|advise|feedback\b(?!\s*(?:table|collection|form|data|survey))|thoughts?|opinion|best(?:\s+\w+)?\s+(?:way|practice|practices|approach|option|design|choice|strategy|structure|format|type|index|indexes|schema)\b|better\b|faster|quicker|(?:this|it|that|everything|(?:the|my|our|these)\s+(?:\w+\s+)?(?:quer(?:y|ies)|report|dashboard|page|joins?|views?|indexe?s?|tables?|schema|database|thing))(?:\s+(?:on|in|for|between|against|over|with|from)\b[\w\s]{0,24}?)?\s+(?:is|are|was|were|runs?|running|feels?|seems?)\s+(?:so |very |really |too )?slow\w*|forever|bad\b|poor\b|terrible|killing|worth (?:it|doing|the)\b|reduc\w*|wrong with|should (?:i|there|this|it)|i should|do you (?:think|see)|do i need|what needs|(?:what )?would you (?:change|do|suggest|recommend|normali[sz]e|denormali[sz]e|add|drop|split|merge|index|partition)|relate[sd]\b|grow\w*|scal(?:e|es|ing|ability)\b|model(?:l?ed|l?ing)\b|needs? (?:to be )?(?:updated?|changed?|fixed?|added?)|problems?|issues? (?:with|in|around)\b|mistakes?|redundant(?=\s+(?:index(?:es)?|indices|columns?|tables?|joins?|constraints?|keys?|data)\b)|unused\s+(?:index(?:es)?|indices|column|columns|table|tables|constraints?|keys?|fields?)\b|unnecessary(?=\s+(?:index(?:es)?|indices|columns?|tables?|joins?|constraints?|keys?)\b)|(?:missing|duplicate)\w*[^.?!]{0,20}\b(?:index(?:es)?|indices|constraints?|keys?|relationships?)|too many|too few|make[s]? sense|properly|correctly|the right way|is (?:this|it|that|my|our)[^.?!]{0,24}\bok(?:ay)?\b|sensible|reasonable|why (?:is|are|am|does|do|did|would)|what does .{0,30}do\b|explain|break down|convert|translate|port\b|migrat\w*|difference between|when should|pros and cons|document(?:s|ing)?\s+(?:the|this|my|our)\b|trade-?offs?|(?:take a )?look at\s+(?:my|the|this|our)\s+(?:schema|database|db|design|data ?model)\b|say about)\b""",
            RegexOption.IGNORE_CASE,
        )

        /** What advice is asked about. Wider than [METADATA_OBJECT_RE]: performance, query text and errors count too. */
        private val ADVICE_OBJECT_RE = Regex(
            """\b(tables?|collections?|columns?|fields?|schemas?|views?|index(?:es|ing|ed)?|indices|relationships?|relations?|foreign keys?|primary keys?|constraints?|triggers?|procedures?|functions?|routines?|sequences?|joins?|partition\w*|shard\w*|embed\w*|documents?|model(?:s|l?ed|l?ing)?\b|quer(?:y|ies)|sql|ddl|statements?|syntax|performance|slow\w*|latency|throughput|rows?|duplicates?|normali[sz]\w*|denormali[sz]\w*|databases?|dbs?|design|structures?|reports?|dashboards?|data ?model\w*|postgres\w*|mysql|mariadb|sqlite|oracle|mongo\w*|duckdb|(?:database|db|data) (?:structure|layout|schema|design|model))\b""",
            RegexOption.IGNORE_CASE,
        )

        /** Asking what the database *is*, not what is in it: the answer is a description, not a table list. */
        private val OVERVIEW_INTENT_RE = Regex(
            """\b(describe|description|detail|details|overview|summar\w*|explain|walk me through|tell me about|understand|introduce|high[- ]level|brief|contain\w*|what(?:'s| is) in|what(?:'s| is) (?:this|the|your)[^.?!]{0,24}\bfor\b|hold\w*)\b""",
            RegexOption.IGNORE_CASE,
        )

        /** The whole database, not one named table - "describe the orders table" is still a column listing. */
        private val OVERVIEW_OBJECT_RE = Regex(
            """\b(schemas?|databases?|db|data ?model\w*|structure|layout|(?:files?|spreadsheets?|csvs?|workbooks?)(?!\s+(?:table|collection)))\b""",
            RegexOption.IGNORE_CASE,
        )

        /** Advice asking what to CHANGE, where an unknown name is a proposal rather than an invention. */
        private val PRESCRIPTIVE_ADVICE_RE = Regex(
            """\b(improv\w*|optimi[sz]\w*|tun(?:e|ing)|speed(?:\s*up)?|normali[sz]\w*|denormali[sz]\w*|redesign\w*|refactor\w*|restructur\w*|(?<!\b(?:the|its|all|these|those|many|few|no|some) )partition\w*|(?<!\b(?:the|its|all|these|those|many|few|no|some) )shard\w*|archiv(?:e|es|ed|ing|al)\b(?!\s*(?:table|log|collection|folder))|rewrit\w*|suggest\w*|recommend\w*|advice|advise|should i|(?:what )?would you (?:change|do|suggest|recommend|normali[sz]e|denormali[sz]e|add|drop|split|merge|index|partition)|missing|add\b|better\b|best\b|reduc\w*|fix\w*|what needs)\b""",
            RegexOption.IGNORE_CASE,
        )

        /** True when an unknown name in the answer is a proposal AskSQL never runs, rather than a hallucination. */
        internal fun isSchemaProposalQuestion(question: String) =
            isSchemaAdviceQuestion(question) && PRESCRIPTIVE_ADVICE_RE.containsMatchIn(question)

        /** "the reporting structure of employees" is a question about rows in a table, not about the database. */
        private val STRUCTURE_OF_TABLE_RE = Regex(
            """\b(?:structure|layout)\s+(?:of|in|for)\s+(?:the |this |that |our |my )?(?!databases?\b|db\b|schemas?\b|data ?model)\w""",
            RegexOption.IGNORE_CASE,
        )
        private val NAMES_THE_DATABASE_RE =
            Regex("""\b(?:schemas?|databases?|db|data ?model)\b""", RegexOption.IGNORE_CASE)

        /** True when the question asks for a description of the database as a whole. */
        /**
         * "How do X and Y relate?" asks about the link itself, which the schema already states.
         * Anchored at the start so filtering by a relationship stays a data question, and first
         * person is excluded: "how do I relate this to revenue" is the reader relating something.
         */
        private val RELATIONSHIP_QUESTION_RE = Regex(
            """^\s*(?:(?:so|and|ok|okay)\s+)?(?:how\s+(?:do|does|are|is)\b(?!\s+i\b)[^.?!]{0,60}\b(?:relate[sd]?|connect(?:ed|s)?|link(?:ed|s)?|associated|tied?\s+together|map\s+to)\b|what(?:'s|\u2019s|\s+is|\s+are)?\s+the\s+(?:relationships?|link|connection|association)\s+between\b(?![^.?!]*\d))""",
            RegexOption.IGNORE_CASE,
        )

        internal fun isRelationshipQuestion(question: String): Boolean =
            RELATIONSHIP_QUESTION_RE.containsMatchIn(question)

        internal fun isDatabaseOverviewQuestion(question: String): Boolean {
            if (STRUCTURE_OF_TABLE_RE.containsMatchIn(question) && !NAMES_THE_DATABASE_RE.containsMatchIn(question)) return false
            return OVERVIEW_INTENT_RE.containsMatchIn(question) && OVERVIEW_OBJECT_RE.containsMatchIn(question)
        }

        /**
         * "write/give me a statement that deletes ..." - asking to be handed a write, not to run one.
         * The write verb has to come AFTER the noun: "write a query that adds up revenue" is a read.
         */
        private val WRITE_REQUEST_RE = Regex(
            """^\s*(?:(?:please|now|ok|okay|so)\s+|(?:can|could|would|will)\s+(?:you|we)\s+|i\s+(?:want|need)\s+(?:you\s+)?to\s+|go ahead and\s+|let'?s\s+)*(?:(?:delete|truncate|erase|purge|wipe|nuke|remove(?!\s+duplicates?\b))\b|(?:drop(?!\s+(?:rows?|records?|duplicates?|nulls?)\b)|insert|update|alter|rename|clear|empty|flush)\b[^.?!]{0,60}\b(?:table|column|row|rows|record|records|from|into|set|every|all|the|this|my|our|to|by|with)\b|(?:add|create)\b[^.?!]{0,60}\b(?:column|table|index|constraint|view|field|foreign key|primary key)\b(?!\s+(?:with|showing|for|of|that|containing|listing|per|by|which)\b))|\b(?:write|create|give|show|generate|produce|draft|compose|need|want|how (?:do|can|would) i)\b[^.?!]{0,60}\b(?:statement|query|sql|ddl|command|script|migration)\b[^.?!]{0,60}\b(?:insert|inserts|inserting|update|updates|updating|delete|deletes|deleting|drop|drops(?!\s+(?:rows?|records?|duplicates?|nulls?)\b)|dropping|truncate|truncates|truncating|alter|alters|altering|remove|removes(?!\s+duplicates?\b)|removing|rename|renames|renaming|wipes?|wiping|purges?|purging|erases?|erasing|clears?|clearing|empties|emptying|flushes?|flushing|add\b[^.?!]{0,24}\b(?:column|index|constraint|table|field|foreign key))\b|\b(?:write|create|give|show|generate|produce|draft|compose|need|want)\b[^.?!]{0,30}\b(?:insert|update|delete|drop|truncate|alter|rename|merge|upsert)\s+(?:statement|query|sql|ddl|command|script|migration)\b|\b(?:write|create|give|show|generate|produce|draft|compose|need|want)\b[^.?!]{0,20}\b(?:insert|update|delete|drop|truncate|alter|merge|upsert)\b\s+(?:that|to|which|for|removing|adding|setting)\b|\b(?:statement|query|sql|ddl|command|script|migration)\b[^.?!]{0,40}\b(?:that|to|which)\b[^.?!]{0,40}\b(?:insert|inserts|update|updates|delete|deletes|drop|drops(?!\s+(?:rows?|records?|duplicates?|nulls?)\b)|truncate|truncates|alter|alters|remove|removes(?!\s+duplicates?\b)|rename|renames|wipes?|purges?|erases?|clears?|empties|flushes?|add\b[^.?!]{0,24}\b(?:column|index|constraint|table|field|foreign key))\b""",
            RegexOption.IGNORE_CASE,
        )

        /** A structure question answerable by a catalog listing; advice is excluded. */
        internal fun isMetadataQuestion(question: String) =
            METADATA_INTENT_RE.containsMatchIn(question) &&
                METADATA_OBJECT_RE.containsMatchIn(question) &&
                !isSchemaAdviceQuestion(question) &&
                !isDatabaseOverviewQuestion(question)

        /** Advice whose intent already names its object, so the non-overlapping rule cannot apply. */
        private val SELF_CONTAINED_ADVICE_RE = Regex(
            """\b(?:unused|redundant|unnecessary)\s+(?:index(?:es)?|indices|constraints?|keys?|relationships?|columns?|tables?|fields?)\b|\b(?:missing|duplicate)\s+(?:index(?:es)?|indices|constraints?|foreign keys?|primary keys?|relationships?)\b|\bbest\s+(?:practices?|approach|design|strategy)\b|\bbest\s+way\s+to\s+(?:store|model|structure|organi[sz]e|handle|represent|index|partition|split|name|design|track)\b|\b(?:what|which)\b[^.?!]{0,30}\b(?:changes?|improvements?|optimi[sz]ations?)\b[^.?!]{0,25}\b(?:needed|required|necessary|recommend\w*|suggest\w*|apply)\b|\b(?:what|which)\s+(?:changes?|improvements?|optimi[sz]ations?)\b[^.?!]{0,20}\bshould\b""",
            RegexOption.IGNORE_CASE,
        )

        /** Advice that names no object because the object is the query in front of the user. */
        private val BARE_ADVICE_RE = Regex(
            """\b(?:what (?:do|should) i do|what now|how do i fix (?:this|it)|any (?:ideas|suggestions)|is it worth\b|(?:this|it|that) (?:is|was|runs?|feels?|seems?) (?:so |very |really |too )?slow|why (?:is|are|does|do|did)\b[\w\s]{0,30}?\b(?:grow\w*|so (?:big|large|slow|fast)))\b""",
            RegexOption.IGNORE_CASE,
        )

        /**
         * True when the question asks for an opinion about the schema or a query rather than for data.
         * The intent and the object must be NON-OVERLAPPING words: partition, shard and normalize are in both lists.
         */
        internal fun isSchemaAdviceQuestion(question: String): Boolean {
            if (BARE_ADVICE_RE.containsMatchIn(question) || SELF_CONTAINED_ADVICE_RE.containsMatchIn(question)) return true
            val intents = ADVICE_INTENT_RE.findAll(question).map { it.range }.toList()
            if (intents.isEmpty()) return false
            // A question frame ("what does this query do") carries its own meaning; the object it contains still counts.
            if (intents.any { question.substring(it.first, it.last + 1).trim().split(Regex("""\s+""")).size >= 3 }) return true
            val objects = ADVICE_OBJECT_RE.findAll(question).map { it.range }.toList()
            return objects.any { o -> intents.any { i -> o.last < i.first || o.first > i.last } }
        }

        /** "run that query", "show me those results": the user means the query they just read, not a new one. */
        private val RERUN_PREVIOUS_RE = Regex(
            """^\s*(?:(?:please|now|ok|okay|yes)\s+|(?:can|could|would|will)\s+(?:you|we)\s+)*(?:re-?)?(?:run|execute|show(?:\s+me)?|give(?:\s+me)?|display)\b[^.?!]{0,40}\b(?:this|that|the\s+(?:previous|last|above|same|first|second|aggregation|aggregate))\b[^.?!]{0,40}$""",
            RegexOption.IGNORE_CASE,
        )

        /** One `term = definition` per line; blank lines and lines without a separator are ignored. */
        fun parseGlossary(text: String): List<Prompts.GlossaryTerm> =
            text.lineSequence()
                .mapNotNull { line ->
                    val at = line.indexOf('=')
                    if (at <= 0) return@mapNotNull null
                    val term = line.substring(0, at).trim()
                    val definition = line.substring(at + 1).trim()
                    if (term.isEmpty() || definition.isEmpty()) null else Prompts.GlossaryTerm(term, definition)
                }
                .take(40)
                .toList()

        /** True when the question asks to run a query already shown, rather than for a new one. */
        internal fun isRerunPreviousRequest(question: String) = RERUN_PREVIOUS_RE.containsMatchIn(question)

        /**
         * True when the user is asking to be handed a write statement, which is proposed rather than
         * generated. "can you delete my data" reads as an imperative but asks what AskSQL is allowed
         * to do, and that has its own answer.
         */
        internal fun isWriteRequest(question: String) =
            WRITE_REQUEST_RE.containsMatchIn(question) && !Scope.isCapabilityQuestion(question)

        /**
         * A write statement offered in an answer, fenced or bare. Matched by statement shape rather
         * than by a ```sql fence, which smaller models omit.
         */
        private val PROPOSED_WRITE_RE = Regex(
            """^\s*(?:```\w*\s*)?(insert\s+into\s|update\s+[\w."`]+(?:\s+(?:as\s+)?[\w"`]+)?\s+set\s|delete\s+(?:from\s|[\w."`]+\s+from\s)|merge\s+into\s|replace\s+into\s|upsert\s+into\s|alter\s+(?:table|schema|view|index|sequence|database)\s|create\s+(?:or\s+replace\s+)?(?:table|index|unique\s+index|view|materialized\s+view|schema|trigger|function|procedure|sequence|database|role|user|type|extension|domain|policy)\s|drop\s+(?:table|index|view|materialized\s+view|schema|trigger|function|procedure|sequence|database|role|user|type|extension|domain|policy)\s|comment\s+on\s+(?:table|column)\s|truncate\s+(?:table\s+)?[\w."`]+\s*;|grant\s+[\w,]+(?:[ \t]+[\w,]+)*\s+on\s+[\w."`]+\s+to\s|revoke\s+[\w,]+(?:[ \t]+[\w,]+)*\s+on\s+[\w."`]+\s+from\s)""",
            setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE),
        )

        /**
         * The same shapes, unanchored: a pasted statement usually follows a colon rather than
         * starting a line ("is this update safe: UPDATE ... SET ..."). Only used on the QUESTION.
         */
        private val WRITE_IN_QUESTION_RE = Regex(
            """(insert\s+into\s|update\s+[\w."`]+(?:\s+(?:as\s+)?[\w"`]+)?\s+set\s|delete\s+(?:from\s|[\w."`]+\s+from\s)|merge\s+into\s|replace\s+into\s|upsert\s+into\s|alter\s+(?:table|schema|view|index|sequence|database)\s|create\s+(?:or\s+replace\s+)?(?:table|index|unique\s+index|view|materialized\s+view|schema|trigger|function|procedure|sequence|database|role|user|type|extension|domain|policy)\s|drop\s+(?:table|index|view|materialized\s+view|schema|trigger|function|procedure|sequence|database|role|user|type|extension|domain|policy)\s|comment\s+on\s+(?:table|column)\s|truncate\s+(?:table\s+)?[\w."`]+\s*;|grant\s+[\w,]+(?:[ \t]+[\w,]+)*\s+on\s+[\w."`]+\s+to\s|revoke\s+[\w,]+(?:[ \t]+[\w,]+)*\s+on\s+[\w."`]+\s+from\s)""",
            setOf(RegexOption.IGNORE_CASE, RegexOption.MULTILINE),
        )

        /** Bounds for the whole-schema answer: past these the prompt stops being an overview and starts being the schema. */
        private const val BROAD_MAX_TABLES = 120
        private const val BROAD_MAX_EDGES = 200

        /** A whole-schema question (relationships, overview, table count) that needs the full picture, not a term-pruned handful of tables. */
        private val BROAD_SCHEMA_RE =
            Regex("""\b(?:relat|overview|summar|structur|entit|connect|erd|diagram)\w*|how many tables?|all (?:the )?tables?|whole (?:schema|database)|about (?:this|the|my) (?:database|schema|db)|what.{0,20}(?:database|schema|db) (?:is|for|about|do)""", RegexOption.IGNORE_CASE)

        /** Each engine's read-only way to list tables; system schemas are exempt from the hallucination floor. */
        internal fun catalogQueryHint(engine: com.rahulmahadik.asksql.ide.model.EngineKind): String = when (engine) {
            com.rahulmahadik.asksql.ide.model.EngineKind.SQLITE ->
                "SELECT name, type FROM sqlite_master WHERE type IN ('table','view')"
            com.rahulmahadik.asksql.ide.model.EngineKind.MYSQL ->
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE()"
            com.rahulmahadik.asksql.ide.model.EngineKind.ORACLE ->
                "SELECT table_name FROM all_tables"
            else ->
                "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"
        }
    }

    data class AskResult(
        val sql: String,
        val explanation: String?,
        val guard: GuardVerdict,
        val connectionId: String,
        val repairs: Int,
    )

    private data class CachedCatalog(
        val catalog: SchemaCatalog,
        val fetchedAtMillis: Long,
        /** Shorter when the introspection carried warnings, so a degraded read is retried sooner. */
        val ttlMillis: Long = CATALOG_TTL.inWholeMilliseconds,
    )

    private val catalogCache = ConcurrentHashMap<String, CachedCatalog>()

    /**
     * A forced re-read skips the TTL, and most business questions name nothing in the catalog, so
     * doing it per question meant a full introspection on nearly every ask. One per cooldown still
     * notices a table added mid-session, which is the point of the re-read.
     */
    private val staleRefreshAt = ConcurrentHashMap<String, Long>()

    private fun mayRefreshForStaleness(connectionId: String): Boolean {
        val last = staleRefreshAt[connectionId] ?: 0L
        if (System.currentTimeMillis() - last < STALE_REFRESH_COOLDOWN_MS) return false
        staleRefreshAt[connectionId] = System.currentTimeMillis()
        return true
    }
    private val catalogLocks = ConcurrentHashMap<String, Mutex>()
    private val catalogGeneration = java.util.concurrent.atomic.AtomicLong(0)

    /** Drops every cached catalog entry. Call on any connection-settings change. */
    fun invalidateCatalogCache() {
        catalogGeneration.incrementAndGet()
        catalogCache.clear()
    }

    /**
     * Drops one connection's cached catalog. Editing or deleting a single connection must not
     * throw away (and immediately re-introspect) every other connection's schema.
     */
    fun invalidateCatalogCache(connectionId: String) {
        catalogGeneration.incrementAndGet()
        catalogCache.remove(connectionId)
    }

    // Catalog (300s TTL, single in-flight fetch per connection)

    suspend fun catalog(descriptor: ConnectionDescriptor, password: String?, refresh: Boolean = false): SchemaCatalog {
        val cached = catalogCache[descriptor.id]
        if (!refresh && cached != null && System.currentTimeMillis() - cached.fetchedAtMillis < cached.ttlMillis) {
            return cached.catalog
        }
        val lock = catalogLocks.getOrPut(descriptor.id) { Mutex() }
        return lock.withLock {
            val recheck = catalogCache[descriptor.id]
            if (!refresh && recheck != null && System.currentTimeMillis() - recheck.fetchedAtMillis < CATALOG_TTL.inWholeMilliseconds) {
                return@withLock recheck.catalog
            }
            val gen = catalogGeneration.get()
            // Blocking JDBC: the fetch carries its own hard timeout.
            val fresh = withHardTimeout(60_000) {
                connectionRegistry.withConnection(descriptor, password) { connection ->
                    Introspectors.forEngine(descriptor.engine).introspect(connection, allowDataInPrompt)
                }
            }
            // An empty catalog WITH warnings is a permission or network failure, not an empty
            // database. Core throws a retryable error; caching it here presented the database as
            // empty for the next five minutes and every question answered "no tables".
            if (fresh.tables.isEmpty() && fresh.warnings.isNotEmpty()) {
                throw AskSqlException(
                    AskSqlErrorCode.DB_QUERY_ERROR,
                    userMessage = "Could not read this database's schema. Check the connection's permissions, then try again.",
                    detail = "introspection returned no tables with warnings: ${fresh.warnings.joinToString("; ").take(500)}",
                    retryable = true,
                )
            }
            // Skip the write if an edit invalidated the cache mid-fetch.
            // A partially-failed introspection is cached only briefly, as in core.
            val cacheFor = if (fresh.warnings.isNotEmpty()) WARNED_CATALOG_TTL_MS else CATALOG_TTL.inWholeMilliseconds
            if (catalogGeneration.get() == gen) {
                catalogCache[descriptor.id] = CachedCatalog(fresh, System.currentTimeMillis(), cacheFor)
            }
            fresh
        }
    }

    // ask(): question -> catalog -> prune -> prompt -> LLM -> extract -> guard -> hallucination floors -> repair loop

    /** The distinct values a coded column holds, kept local. Null when not certain: a wrong caveat is worse than none. */
    private suspend fun codeValuesOf(
        descriptor: ConnectionDescriptor,
        password: String?,
        schema: String?,
        table: String,
        column: String,
    ): List<String>? = try {
        val dialect = Dialects.of(descriptor.engine)
        val q = dialect.quoteChar
        fun id(name: String) = "$q${name.replace(q.toString(), "$q$q")}$q"
        // Qualified when the catalog knows a schema: unqualified, the probe errored outside the
        // search path, the catch returned null, and the check went quiet.
        val relation = if (schema.isNullOrBlank()) id(table) else "${id(schema)}.${id(table)}"
        val select = "SELECT DISTINCT ${id(column)} AS v FROM $relation"
        val cap = CODE_MAX_DISTINCT + 1
        val sql = if (dialect.limitStyle == LimitStyle.FETCH) "$select FETCH FIRST $cap ROWS ONLY" else "$select LIMIT $cap"
        val result = connectionRegistry.withConnection(descriptor, password) { connection ->
            JdbcExecutor.execute(connection, sql, cap, CODE_PROBE_TIMEOUT_MS, descriptor.engine)
        }
        if (result.rows.isEmpty() || result.rows.size > CODE_MAX_DISTINCT) {
            null
        } else {
            // An all-NULL column returns one NULL row, which is not zero rows: without this the
            // pick-from list came out empty and the repair asked the model to choose from nothing.
            result.rows.mapNotNull { row -> row.firstOrNull()?.let { codeText(it) } }.ifEmpty { null }
        }
    } catch (e: Exception) {
        null // a probe that cannot answer says nothing
    }

    /** A cell as the literal a query would compare against: a whole Number must not read as "2.0". */
    private fun codeText(cell: CellValue): String? = when (cell) {
        is CellValue.ExactNumeric -> cell.value
        is CellValue.Text -> cell.value
        is CellValue.Number -> if (cell.value == Math.floor(cell.value) && !cell.value.isInfinite()) {
            cell.value.toLong().toString()
        } else {
            cell.value.toString()
        }
        else -> null
    }

    suspend fun ask(
        question: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        llmClient: LlmClient,
        context: List<Prompts.ContextTurn> = emptyList(),
        onEvent: EngineEventListener? = null,
        /** From `AskSqlAppSettings.customInstructions`; see [Prompts.buildSqlSystem]. */
        customInstructions: String? = null,
        /** From `AskSqlAppSettings.glossary`, one `term = definition` per line. */
        glossaryText: String? = null,
    ): AskResult {
        val q = question.trim()
        val glossary = parseGlossary(glossaryText.orEmpty())
        if (q.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT)
        if (q.length > 10_000) {
            throw AskSqlException(
                AskSqlErrorCode.INVALID_INPUT,
                userMessage = "The question is too long. Keep it under 10,000 characters.",
            )
        }

        // Answered deterministically on the prose path rather than by the model.
        if (Scope.isCapabilityQuestion(q)) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_CANNOT_ANSWER,
                userMessage = "That is a question about AskSQL itself rather than the data.",
                detail = "capability question routed to the prose path",
                retryable = false,
            )
        }
        // Declined before any model call: a small model can be argued into answering these.
        if (Scope.isPromptInjection(q)) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_REFUSAL,
                userMessage = "I only answer questions about the data in this database.",
                detail = "prompt-injection attempt declined",
                retryable = false,
            )
        }

        // A request to be handed a write goes to the prose path, before any model call.
        if (isWriteRequest(q)) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_CANNOT_ANSWER,
                userMessage = "That asks for a statement that changes data. AskSQL is read-only, so it is written out for you to run yourself.",
                detail = "write request routed to the proposal path",
                retryable = false,
            )
        }
        if (isSchemaAdviceQuestion(q) || isDatabaseOverviewQuestion(q) || isRelationshipQuestion(q)) {
            throw AskSqlException(
                AskSqlErrorCode.LLM_CANNOT_ANSWER,
                userMessage = "That asks about the schema itself rather than the data in it, so there is no query to run.",
                detail = "schema-advice question routed to the prose path",
                retryable = false,
            )
        }

        val dialect = Dialects.of(descriptor.engine)

        onEvent?.onEvent(EngineEvent.StageEvent(Stage.CATALOG))
        var fullCatalog = catalog(descriptor, password)
        // A question naming nothing we hold usually means the catalog is stale, not that the question
        // is wrong. Gated on age because a refresh skips the TTL, and most business questions name
        // nothing either.
        if (!SchemaFuzzyMatch.namesSomethingInCatalog(q, fullCatalog) && mayRefreshForStaleness(descriptor.id)) {
            fullCatalog = try { catalog(descriptor, password, refresh = true) } catch (e: Exception) { fullCatalog }
        }

        // A handful of structure questions have an exact answer, and a model reliably guesses the
        // system-catalog columns wrong. Writing those here skips the model rather than repairing it.
        CatalogAnswers.catalogQueryFor(q, fullCatalog, dialect)?.let { written ->
            val verdict = SqlGuard.guard(written.sql, dialect, policy)
            if (verdict.allowed) {
                onEvent?.onEvent(EngineEvent.StageEvent(Stage.DONE))
                return AskResult(
                    sql = verdict.sql,
                    explanation = written.explanation,
                    guard = verdict,
                    connectionId = descriptor.id,
                    repairs = 0,
                )
            }
        }

        // Names the engine would not read back as themselves: folded case, reserved words, symbols.
        // A name spelled two ways across the catalog is skipped: rewriting "status" to "Status" would
        // ask one table for another table's column.
        val allNames = fullCatalog.tables.flatMap { t -> listOf(t.name) + t.columns.map { it.name } }
        val spellings = allNames.groupBy { it.lowercase() }
        val quotableNames = allNames.filter {
            CatalogPruner.needsQuoting(it, descriptor.engine) && spellings[it.lowercase()]?.distinct()?.size == 1
        }
        // Only a table may be quoted before a dot; a schema qualifier that matched a column name broke it.
        val quotableTables = fullCatalog.tables.map { it.name }.filter { it in quotableNames }

        onEvent?.onEvent(EngineEvent.StageEvent(Stage.PRUNE))
        val initialPrunerSettings = CatalogPruner.PrunerSettings(maxSchemaTokens = maxSchemaTokens)
        var pruned = CatalogPruner.pruneCatalog(fullCatalog, q, initialPrunerSettings)
        var schemaText = pruned.schemaText
        if (pruned.dropped > 0) {
            onEvent?.onEvent(EngineEvent.Warning("Schema narrowed to ${pruned.catalog.tables.size} relevant tables."))
        }

        val system = Prompts.buildSqlSystem(dialect, policy.maxRows, customInstructions)
        var userPrompt = Prompts.buildSqlUser(
            question = q,
            schemaText = schemaText,
            glossary = glossary,
            context = context,
            rerunPrevious = isRerunPreviousRequest(q),
            database = descriptor.database,
            schemas = fullCatalog.schemas,
            catalogHint = if (isMetadataQuestion(q)) catalogQueryHint(descriptor.engine) else null,
        )

        var lastSql = ""
        // True only while every reply has been empty, which is what marks the model unreachable.
        var everyReplyEmpty = true
        var attempt = 0
        var contextShrunk = false
        var triedFuzzyTableRepair = false
        var triedCatalogRepair = false
        while (true) {
            onEvent?.onEvent(EngineEvent.StageEvent(if (attempt == 0) Stage.LLM else Stage.REPAIR, "attempt ${attempt + 1}"))

            val result = try {
                com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                    llmClient.chat(system, userPrompt) { token -> onEvent?.onEvent(EngineEvent.Token(token)) }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e // the coroutine's own cancellation signal; must propagate unwrapped
            } catch (e: AskSqlException) {
                // On context overflow, shrink the schema once and retry without consuming a repair attempt.
                if (e.code == AskSqlErrorCode.LLM_CONTEXT_OVERFLOW && !contextShrunk) {
                    contextShrunk = true
                    val tighter = CatalogPruner.pruneCatalog(
                        fullCatalog, q,
                        CatalogPruner.PrunerSettings(
                            maxTables = maxOf(5, pruned.catalog.tables.size / 2),
                            maxSchemaTokens = maxOf(1000, initialPrunerSettings.maxSchemaTokens / 2),
                        ),
                    )
                    pruned = tighter
                    schemaText = tighter.schemaText
                    userPrompt = Prompts.buildSqlUser(
                        question = q, schemaText = schemaText, context = context,
                        database = descriptor.database, schemas = fullCatalog.schemas,
                    )
                    continue
                }
                throw e
            } catch (e: Exception) {
                throw AskSqlException.from(e, AskSqlErrorCode.LLM_UNAVAILABLE)
            }
            val text = result.text

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.EXTRACT))
            // extractSql runs first: a model can hedge with "IMPOSSIBLE: ..." and still emit usable SQL.
            val extraction = Extract.extractSql(text)
            if (extraction == null) {
                val impossibleReason = Extract.extractImpossible(text)
                if (impossibleReason != null) {
                    // A refused "show tables" is re-asked as a plain SELECT over the catalog views; a rephrase spends no repair attempt.
                    if (!triedCatalogRepair && isMetadataQuestion(q)) {
                        triedCatalogRepair = true
                        userPrompt = Prompts.buildRepairUser(
                            question = q, failedSql = "",
                            failure = "This asks about the database's own structure. Don't use SHOW/DESCRIBE, and don't invent a schema name to filter on. Answer with exactly this query, unchanged: ${catalogQueryHint(descriptor.engine)}",
                            schemaText = schemaText, dialect = dialect,
                        )
                        continue
                    }
                    // A refusal is often a misspelled table name; retry once with the closest match, disclosed in the explanation.
                    val fuzzyTable = if (!triedFuzzyTableRepair) SchemaFuzzyMatch.closestTableName(q, fullCatalog) else null
                    if (fuzzyTable != null) {
                        triedFuzzyTableRepair = true
                        userPrompt = Prompts.buildRepairUser(
                            question = q, failedSql = "",
                            failure = "No table matches the question exactly, but \"$fuzzyTable\" is a close match, likely the same word misspelled. If that's what's meant, answer using \"$fuzzyTable\" and say in the explanation that an exact match wasn't found so \"$fuzzyTable\" was used instead.",
                            schemaText = schemaText, dialect = dialect,
                        )
                        continue
                    }
                    throw AskSqlException(AskSqlErrorCode.LLM_CANNOT_ANSWER, userMessage = impossibleReason, retryable = false)
                }
            }
            if (text.isNotBlank()) everyReplyEmpty = false
            if (extraction == null) {
                if (attempt >= MAX_REPAIRS) {
                    // Nothing at all on every attempt: the model name is wrong or the account cannot reach it.
                    if (everyReplyEmpty) {
                        throw AskSqlException(
                            AskSqlErrorCode.LLM_UNAVAILABLE,
                            userMessage = "The AI model returned an empty response. Check the model name is right and that your account can use it.",
                            detail = "model returned nothing on all ${attempt + 1} attempts",
                        )
                    }
                    val refusal = Extract.looksLikeRefusal(text)
                    throw AskSqlException(
                        if (refusal) AskSqlErrorCode.LLM_REFUSAL else AskSqlErrorCode.LLM_BAD_OUTPUT,
                        detail = "no SQL extracted after ${attempt + 1} attempts",
                    )
                }
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = lastSql,
                    failure = "The response contained no SQL statement. Reply with one SELECT in a ```sql fence.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }
            lastSql = extraction.sql

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.GUARD))
            // Quote first: a folding engine resolves a bare name elsewhere, and the parser cannot read a
            // bare table named like a keyword. Falls back untouched if quoting makes it unparseable.
            val quotedNames =
                IdentifierCase.quoteCatalogIdentifiers(extraction.sql, quotableNames, dialect.quoteChar, quotableTables)
            // A reserved word used as an alias only needs quoting: MySQL rejects `... AS rank` outright.
            val withAliases =
                IdentifierCase.quoteReservedAliases(quotedNames ?: extraction.sql, dialect.quoteChar, descriptor.engine.name.lowercase())
            val normalised = withAliases ?: quotedNames
            val normalisedVerdict = normalised?.let { SqlGuard.guard(it, dialect, policy) }
            // Falling back to the model's SQL would drop the identifier quoting too, and on a
            // folding engine that quoting is what makes a mixed-case name resolve at all.
            val namesOnlyVerdict =
                if (normalisedVerdict?.allowed != true && quotedNames != null && quotedNames != normalised) {
                    SqlGuard.guard(quotedNames, dialect, policy)
                } else {
                    null
                }
            val verdict = when {
                normalisedVerdict?.allowed == true -> normalisedVerdict
                namesOnlyVerdict?.allowed == true -> namesOnlyVerdict
                else -> SqlGuard.guard(extraction.sql, dialect, policy)
            }
            if (!verdict.allowed) {
                if (attempt >= MAX_REPAIRS) {
                    history.add(auditEntry(descriptor.id, q, extraction.sql, HistoryStatus.BLOCKED, verdict.ruleId))
                    throw AskSqlException(
                        AskSqlErrorCode.GUARD_BLOCKED,
                        userMessage = "I didn't run that one for safety: ${verdict.reason ?: "the generated statement is not allowed."}",
                        detail = "ruleId=${verdict.ruleId} after ${attempt + 1} attempts",
                    )
                }
                // "could not parse" alone leaves the model repeating the same statement; name the real cause.
                // The validator's parser rejects WITHIN GROUP, for a reason "cannot parse" hides.
                val orderedSetHint = if (Regex("""\bwithin\s+group\b""", RegexOption.IGNORE_CASE).containsMatchIn(extraction.sql)) {
                    " The safety validator cannot read WITHIN GROUP here. Answer without it: return the rows themselves rather than concatenating them into one value."
                } else {
                    ""
                }
                val quoteHint = if (IdentifierCase.hasUnterminatedLiteral(extraction.sql, dialect.quoteChar == '`')) {
                    " A text value contains an apostrophe that is not escaped: write it doubled, as 'O''Brien'."
                } else ""
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = extraction.sql,
                    failure = "The SQL validator rejected it: ${verdict.reason ?: verdict.ruleId ?: "not allowed"}.$quoteHint$orderedSetHint Produce a single read-only SELECT.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }

            // A hardcoded string SELECT is a dodge, not a query; version()/NOW() are genuine zero-table answers.
            if (verdict.tables.isEmpty() && (verdict.sql.contains("IMPOSSIBLE", ignoreCase = true) || LITERAL_STRING_ANSWER_RE.containsMatchIn(verdict.sql.trim()))) {
                throw AskSqlException(
                    AskSqlErrorCode.LLM_CANNOT_ANSWER,
                    userMessage = "That question doesn't seem to match any table in this database.",
                    retryable = false,
                )
            }

            val unknownTable = HallucinationChecks.firstUnknownTable(verdict.sql, fullCatalog, verdict.tables)
            if (unknownTable != null) {
                if (attempt >= MAX_REPAIRS) {
                    // Same reasoning as the column case: say what IS there, and name the closest match.
                    val names = fullCatalog.tables.map { if (it.schema != null) "${it.schema}.${it.name}" else it.name }
                    val closest = SchemaFuzzyMatch.closestTableName(unknownTable, fullCatalog)
                    val suggestion = if (closest != null) " Did you mean $closest?" else ""
                    val more = if (names.size > 12) ", ..." else ""
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_BAD_OUTPUT,
                        userMessage = "The AI kept referring to a table called \"$unknownTable\", which this database does not have, " +
                            "so nothing was run.$suggestion Available: ${names.take(12).joinToString(", ")}$more.",
                        retryable = false,
                    )
                }
                // The column repair already names the real columns; give the table repair the same head start.
                val nearest = SchemaFuzzyMatch.closestTableName(unknownTable, fullCatalog)
                val didYouMean = if (nearest != null) " Did you mean \"$nearest\"?" else ""
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql,
                    failure = "Table \"$unknownTable\" does not exist in the schema.$didYouMean Use only tables from the <schema> block.",
                    schemaText = schemaText, dialect = dialect, allowImpossible = true,
                )
                attempt++
                continue
            }

            // Semantic floor: a column two joined tables both own. Every engine rejects it unqualified.
            val ambiguous = HallucinationChecks.ambiguousColumn(verdict.sql, fullCatalog)
            if (ambiguous != null && attempt < MAX_REPAIRS) {
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql,
                    failure = "\"$ambiguous\" exists on more than one of the joined tables, so on its own it is " +
                        "ambiguous. Qualify it with the table or alias it belongs to.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }

            // Semantic floor: an aggregate beside a bare column with no GROUP BY, which PostgreSQL and strict MySQL reject.
            val needsGrouping = Semantics.ungroupedAggregate(verdict.sql)
            if (needsGrouping != null && attempt < MAX_REPAIRS) {
                userPrompt = Prompts.buildRepairUser(
                    question = q,
                    failedSql = verdict.sql,
                    failure = "The query selects \"$needsGrouping\" alongside an aggregate but has no GROUP BY, so it does not answer the question. " +
                        "Either group by \"$needsGrouping\", or drop it and aggregate over the whole table - whichever the question asks for.",
                    schemaText = schemaText,
                    dialect = dialect,
                )
                attempt++
                continue
            }

            // Semantic floor: AVG(SUM(x)) and friends. Every engine rejects it, so repair before executing.
            val nested = Semantics.nestedAggregate(verdict.sql)
            if (nested != null && attempt < MAX_REPAIRS) {
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql,
                    failure = "$nested() contains another aggregate, which no SQL engine allows. Aggregate once " +
                        "over the rows, or aggregate the inner result in a subquery or CTE and then aggregate that.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }

            // Fan-out floor, mirroring packages/core/src/engine.ts: summing a parent's column across a
            // one-to-many join counts each value once per child row. Read-only, guard-clean, and the
            // total is simply too high - the reader has no way to tell.
            val fanOut = Semantics.fanOutAggregate(verdict.sql, fullCatalog)
            if (fanOut != null && attempt < MAX_REPAIRS) {
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql,
                    failure = "The query sums \"${fanOut.parent}.${fanOut.column}\" while joined to \"${fanOut.child}\", which has " +
                        "many rows per \"${fanOut.parent}\" row, so each value is counted once per \"${fanOut.child}\" row and the " +
                        "total is too high. Aggregate \"${fanOut.child}\" in a separate subquery or CTE and join the result, or " +
                        "drop the join if the question does not need it.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }

            // Epoch floor, mirroring packages/core/src/engine.ts: SQLite has no date type, so Room writes
            // epoch milliseconds into an INTEGER. Compared with a text date nothing matches and the answer
            // is reported as zero; compared with epoch seconds every row matches. Neither errors.
            val epoch = Semantics.epochUnitMismatch(verdict.sql, fullCatalog)
            if (epoch != null && attempt < MAX_REPAIRS) {
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql,
                    failure = "\"${epoch.column}\" is ${epoch.dbType}, so it holds a number, not a date, and comparing it " +
                        "with ${epoch.comparedTo} does not select the rows intended: against text nothing matches, and " +
                        "against epoch seconds a column of milliseconds matches everything. Compare it in its own units - " +
                        "build the bound as a number, for example (strftime('%s','now') - 7*86400) * 1000 for " +
                        "milliseconds - or convert the column with the matching divisor before comparing.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }

            val unknownColumn = HallucinationChecks.firstUnknownColumn(verdict.sql, fullCatalog)
            if (unknownColumn != null) {
                if (attempt >= MAX_REPAIRS) {
                    // Name the columns that do exist, the same list the repair prompt had.
                    val columns = unknownColumn.available.take(12).joinToString(", ")
                    val more = if (unknownColumn.available.size > 12) ", ..." else ""
                    throw AskSqlException(
                        AskSqlErrorCode.LLM_BAD_OUTPUT,
                        userMessage = "The AI kept using a \"${unknownColumn.column}\" column on ${unknownColumn.table}, which does not exist, " +
                            "so nothing was run. ${unknownColumn.table} has: $columns$more. " +
                            "Try naming the column you mean - or use a larger model, which is usually the real fix.",
                        retryable = false,
                    )
                }
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql,
                    failure = "Column \"${unknownColumn.column}\" does not exist on table \"${unknownColumn.table}\". Its real columns are: ${unknownColumn.available.joinToString(", ")}.",
                    schemaText = schemaText, dialect = dialect, allowImpossible = true,
                )
                attempt++
                continue
            }

            // Coded-value floor, mirroring packages/core/src/engine.ts: `status = 2` where no row has 2
            // returns a zero indistinguishable from a true one. Naming the real values to the model is
            // row data, which only allowDataInPrompt permits.
            var impossible: Triple<String, Long, List<String>>? = null
            // Grouped by column before taking: taken by literal, `status IN (0,1) AND total_cents = 9`
            // spent both probes re-reading `status` and never looked at the column that was absent.
            val byColumn = Semantics.codeLiterals(verdict.sql, fullCatalog)
                .groupBy { "${it.schema.orEmpty()}.${it.table}.${it.column}".lowercase() }
                .values.mapNotNull { it.firstOrNull() }
            for (candidate in byColumn.take(CODE_MAX_PROBES)) {
                val values = codeValuesOf(descriptor, password, candidate.schema, candidate.table, candidate.column) ?: continue
                // Numerically, not textually: NUMERIC(5,2) renders 18 as "18.00", and comparing the
                // strings reported a value as absent while the query it came from was returning rows.
                if (values.any { it == candidate.literal.toString() || it.toDoubleOrNull() == candidate.literal.toDouble() }) continue
                impossible = Triple("${candidate.table}.${candidate.column}", candidate.literal, values)
                break
            }
            if (impossible != null && attempt < MAX_REPAIRS && allowDataInPrompt) {
                userPrompt = Prompts.buildRepairUser(
                    question = q, failedSql = verdict.sql, allowImpossible = true,
                    failure = "No row has ${impossible.first} = ${impossible.second}. The values it actually holds are: " +
                        "${impossible.third.joinToString(", ")}. Pick from those, and if none of them answers the " +
                        "question, say so rather than choosing one.",
                    schemaText = schemaText, dialect = dialect,
                )
                attempt++
                continue
            }
            val codeNote = impossible?.let {
                "No row has ${it.first} = ${it.second}, so this returns nothing for that reason rather than " +
                    "because nothing matched the question. If it is a status or type code, what each value " +
                    "means is defined in the application, not the database."
            }

            // Non-blocking: the query still runs. A pronoun with no antecedent means the model chose a
            // subject on its own, which is worth saying rather than refusing over.
            val dangling = Scope.danglingReference(q, context.any { it.sql.isNotBlank() })
            val notes = listOfNotNull(
                codeNote,
                dangling?.let {
                    "\"$it\" does not refer to anything earlier in this conversation, so the query below " +
                        "picked a subject on its own. Name who you mean and ask again if that is wrong."
                },
            )
            for (note in notes) onEvent?.onEvent(EngineEvent.Warning(note))

            onEvent?.onEvent(EngineEvent.StageEvent(Stage.DONE))
            return AskResult(
                sql = verdict.sql,
                explanation = extraction.explanation,
                guard = if (notes.isEmpty()) verdict else verdict.copy(warnings = verdict.warnings + notes),
                connectionId = descriptor.id,
                repairs = attempt,
            )
        }
    }

    // execute(): guard EVERY sql, even one the caller already saw guarded once.

    suspend fun execute(
        sql: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        question: String? = null,
        maxRows: Int? = null,
        timeoutMs: Long = DEFAULT_QUERY_TIMEOUT_MS,
    ): AskSqlResultSet {
        val dialect = Dialects.of(descriptor.engine)
        val verdict = SqlGuard.guard(sql, dialect, policy)
        if (!verdict.allowed) {
            history.add(auditEntry(descriptor.id, question, sql, HistoryStatus.BLOCKED, verdict.ruleId))
            throw AskSqlException(
                AskSqlErrorCode.GUARD_BLOCKED,
                userMessage = "I didn't run that one for safety: ${verdict.reason ?: "this statement is not allowed."}",
                detail = "ruleId=${verdict.ruleId} sql=${sql.take(300)}",
            )
        }

        val started = System.currentTimeMillis()
        // Clamp the caller's maxRows to the policy ceiling; Oracle gets no injected LIMIT, only this driver cap.
        val cappedMax = minOf(maxRows ?: policy.maxRows, policy.maxRows)
        return try {
            val result = connectionRegistry.withConnection(descriptor, password) { connection ->
                JdbcExecutor.execute(connection, verdict.sql, cappedMax, timeoutMs, descriptor.engine)
            }
            history.add(auditEntry(descriptor.id, question, verdict.sql, HistoryStatus.OK, durationMs = System.currentTimeMillis() - started, rowCount = result.rowCount))
            val warnings = result.warnings.toMutableList()
            // Notes attached at ask time (a dangling pronoun) ride the verdict. The Warning event
            // goes to a transient status label the next update overwrites, so carry them here too.
            warnings += verdict.warnings
            if (verdict.autoLimited) warnings += "A row limit of ${policy.maxRows} was added automatically - export to get everything."
            if (verdict.loweredLimit) warnings += "The row limit was lowered to ${policy.maxRows}."
            // The injected LIMIT equals maxRows, so an auto-limited result that fills the cap counts as truncated.
            val truncated = result.truncated || (verdict.autoLimited && result.rowCount >= cappedMax)
            result.copy(warnings = warnings, truncated = truncated)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // a user-initiated cancel: propagate unwrapped and unaudited
        } catch (e: Exception) {
            val mapped = AskSqlException.from(e, AskSqlErrorCode.DB_QUERY_ERROR)
            history.add(auditEntry(descriptor.id, question, verdict.sql, HistoryStatus.ERROR, mapped.code.name, System.currentTimeMillis() - started))
            throw mapped
        }
    }

    /**
     * Asks the model to correct a database-rejected statement, grounded in the schema. Returns the
     * guarded corrected SQL, or null without a safe, different suggestion. Never runs the query.
     */
    suspend fun suggestFix(
        failedSql: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        question: String?,
        errorDetail: String?,
        llmClient: LlmClient,
        customInstructions: String? = null,
    ): String? {
        val bad = failedSql.trim()
        val q = question?.trim().orEmpty()
        if (bad.isEmpty() || q.isEmpty()) return null
        return try {
            val dialect = Dialects.of(descriptor.engine)
            val catalog = catalog(descriptor, password)
            // A wrong-cased table is repairable from the catalog alone, so try that before the model.
            if (errorDetail != null && IdentifierCase.looksLikeUnknownTable(errorDetail)) {
                val cased = IdentifierCase.correctTableCase(
                    bad, catalog.tables.map { it.name }, dialect.quoteChar,
                    IdentifierCase.foldingFor(descriptor.engine.name),
                )
                if (cased != null) {
                    val casedVerdict = SqlGuard.guard(cased, dialect, policy)
                    if (casedVerdict.allowed) return casedVerdict.sql
                }
            }
            val schemaText = CatalogPruner.pruneCatalog(catalog, q).schemaText
            val repairPrompt = Prompts.buildRepairUser(
                question = q, failedSql = bad,
                // A driver error can quote the offending row; the reader never asked to send it.
                failure = "The database rejected it: ${errorDetail?.let { ErrorRedaction.redactValuesInError(it) } ?: "the query failed to run"}",
                schemaText = schemaText, dialect = dialect,
            )
            val repaired = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                llmClient.chat(Prompts.buildSqlSystem(dialect, policy.maxRows, customInstructions), repairPrompt)
            }
            val extraction = Extract.extractSql(repaired.text) ?: return null
            val verdict = SqlGuard.guard(extraction.sql, dialect, policy)
            if (!verdict.allowed || verdict.sql == bad) return null
            // The same hallucination floors ask()'s repair loop enforces.
            if (HallucinationChecks.firstUnknownTable(verdict.sql, catalog, verdict.tables) != null) return null
            if (HallucinationChecks.firstUnknownColumn(verdict.sql, catalog) != null) return null
            verdict.sql
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e // a user-initiated cancel is not "no fix available"; must propagate
        } catch (e: Exception) {
            null // best-effort; the original error stands
        }
    }

    suspend fun explain(sql: String, descriptor: ConnectionDescriptor, password: String?, llmClient: LlmClient): String {
        val s = sql.trim()
        if (s.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT, userMessage = "Provide a SQL statement to explain.")
        val dialect = Dialects.of(descriptor.engine)
        // Guard first: `sql` is caller-supplied and not necessarily already guarded.
        val verdict = SqlGuard.guard(s, dialect, policy)
        if (!verdict.allowed) {
            throw AskSqlException(
                AskSqlErrorCode.GUARD_BLOCKED,
                userMessage = "Only a read-only SQL query can be explained.",
                detail = "explain blocked: ${verdict.reason ?: "not a read-only statement"}",
            )
        }
        val schemaText = try {
            CatalogPruner.pruneCatalog(catalog(descriptor, password), s).schemaText
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
        val result = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
            llmClient.chat(Prompts.buildExplainSystem(dialect), Prompts.buildExplainUser(s, schemaText))
        }
        return result.text.trim()
    }


    /**
     * Answers a schema question in prose, grounded in the catalog: structure only, never data values.
     * [SchemaAnswer.grounded] is false if the answer named identifiers absent from the schema.
     */
    suspend fun explainSchema(
        question: String,
        descriptor: ConnectionDescriptor,
        password: String?,
        llmClient: LlmClient,
        /** Prior turns, so a follow-up like "explain this query" knows which query. */
        context: List<Prompts.ContextTurn> = emptyList(),
    ): Scope.SchemaAnswer {
        val q = question.trim()
        if (q.isEmpty()) throw AskSqlException(AskSqlErrorCode.INVALID_INPUT, userMessage = "Ask a question about the schema.")
        // Same cap as every other entry point.
        if (q.length > 10_000) {
            throw AskSqlException(
                AskSqlErrorCode.INVALID_INPUT,
                userMessage = "The question is too long. Keep it under 10,000 characters.",
            )
        }
        val dialect = Dialects.of(descriptor.engine)
        // Answered in code, not by the model.
        if (Scope.isPromptInjection(q)) return Scope.offTopicAnswer(dialect.promptLabel)
        if (Scope.isCapabilityQuestion(q)) return Scope.capabilityAnswer(dialect.promptLabel)
        val fullCatalog = catalog(descriptor, password)
        if (fullCatalog.tables.isEmpty()) {
            return Scope.SchemaAnswer("This connection has no tables the current user can read.", emptyList(), true, emptyList(), false)
        }
        // Advice counts too: names that do not exist yet are proposals, not hallucinations.
        val isSchemaChange = Grounding.SCHEMA_CHANGE_RE.containsMatchIn(q) || isSchemaProposalQuestion(q)
        // A write request is a proposal too, and AskSQL has promised to write the statement out. The
        // model is neither offered the refusal nor left unable to state the statement.
        val proposesWrite = isWriteRequest(q)
        // A whole-schema question gets a compact list of ALL tables plus the full join graph instead of term pruning.
        val schemaText: String
        val relationships: List<String>
        val contextTables: List<TableInfo>
        if (BROAD_SCHEMA_RE.containsMatchIn(q)) {
            // Bounded list, with the omitted count stated in the preamble.
            val listed = fullCatalog.tables.take(BROAD_MAX_TABLES)
            relationships = CatalogPruner.joinGraph(fullCatalog).take(BROAD_MAX_EDGES)
            val list = listed.joinToString("\n") { t ->
                val pk = if (t.primaryKey.isNotEmpty()) ", pk ${t.primaryKey.joinToString(",")}" else ""
                "${if (t.schema != null) "${t.schema}." else ""}${t.name} (${t.kind.name.lowercase()}, ${t.columns.size} cols$pk)"
            }
            val omitted = fullCatalog.tables.size - listed.size
            val preamble = if (omitted > 0) {
                " The ${listed.size} listed below are a sample; $omitted more are not shown, so describe the database in general terms and say the list is partial."
            } else {
                " Full list:"
            }
            schemaText = "This database has exactly ${fullCatalog.tables.size} tables/views.$preamble\n$list"
            contextTables = listed
        } else {
            val pruned = CatalogPruner.pruneCatalog(fullCatalog, q)
            schemaText = pruned.schemaText
            relationships = CatalogPruner.joinGraph(pruned.catalog)
            contextTables = pruned.catalog.tables
        }
        val tables = contextTables.map { if (it.schema != null) "${it.schema}.${it.name}" else it.name }
        val system = Prompts.buildSchemaAnswerSystem(dialect, isSchemaChange || proposesWrite, allowOutOfScope = !proposesWrite)
        var answer = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
            llmClient.chat(system, Prompts.buildSchemaAnswerUser(q, schemaText, relationships, context))
        }.text.trim()
        // Naming a real catalog object, or carrying prior turns, makes the question one about this database.
        val questionIsAboutThisDatabase =
            Scope.looksDatabaseRelated(q) || isSchemaChange || proposesWrite ||
                Grounding.mentionsCatalogName(q, fullCatalog) || context.any { it.sql.isNotBlank() }
        if (Scope.isOffTopic(answer) || (Scope.isDegenerateAnswer(answer) && !PROPOSED_WRITE_RE.containsMatchIn(answer))) {
            // Challenge the refusal once when the question is plainly about data; accept it otherwise.
            if (!questionIsAboutThisDatabase) return Scope.offTopicAnswer(dialect.promptLabel)
            // No sentinel in this system prompt: the question is already known to be about data.
            answer = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                llmClient.chat(
                    Prompts.buildSchemaAnswerSystem(dialect, isSchemaChange || proposesWrite, allowOutOfScope = false),
                    Prompts.buildSchemaAnswerScopeRepairUser(q, schemaText, dialect.promptLabel, relationships),
                )
            }.text.trim()
            // The retry has no sentinel, so a continued refusal arrives as prose; decline on that too.
            if (
                Scope.isOffTopic(answer) ||
                (Scope.isDegenerateAnswer(answer) && !PROPOSED_WRITE_RE.containsMatchIn(answer)) ||
                Scope.isProseRefusal(answer, Grounding.mentionsCatalogName(answer, fullCatalog))
            ) {
                return Scope.offTopicAnswer(dialect.promptLabel)
            }
        }
        // Deterministic backstop for models too small to follow the sentinel rule.
        if (
            !questionIsAboutThisDatabase &&
            !Grounding.mentionsCatalogName(answer, fullCatalog) &&
            !Scope.looksDatabaseRelated(answer) &&
            !PROPOSED_WRITE_RE.containsMatchIn(answer)
        ) {
            return Scope.offTopicAnswer(dialect.promptLabel)
        }
        // Strip before grounding: snake_case `out_of_scope` would otherwise read as an invented name.
        answer = Scope.stripSentinel(answer)
        // Grounding floor checked against the full catalog, so a real table dropped by pruning isn't flagged.
        var unknown = Grounding.unknownReferencesInProse(answer, fullCatalog)
        // One repair pass for understanding questions; skipped for a change request, where new names are the proposal.
        if (unknown.isNotEmpty() && !isSchemaChange) {
            answer = com.rahulmahadik.asksql.ide.llm.LlmClients.withChatTimeout {
                // No sentinel: this pass only fixes names.
                llmClient.chat(
                    Prompts.buildSchemaAnswerSystem(dialect, isSchemaChange || proposesWrite, allowOutOfScope = false),
                    Prompts.buildSchemaAnswerRepairUser(q, schemaText, unknown, relationships),
                )
            }.text.trim()
            // Sentinel only, matching core: a terse but correct repair is still an answer.
            if (Scope.isOffTopic(answer)) return Scope.offTopicAnswer(dialect.promptLabel)
            unknown = Grounding.unknownReferencesInProse(answer, fullCatalog)
        }
        // A proposed write, in the answer or pasted into the question, always carries the read-only note.
        if ((PROPOSED_WRITE_RE.containsMatchIn(answer) || WRITE_IN_QUESTION_RE.containsMatchIn(q)) && !answer.contains("read-only", ignoreCase = true)) {
            answer += "\n\n*Proposal only - AskSQL is read-only and never executes statements; run it yourself if you want it applied.*"
        }
        // A prose answer often ends in a query the user then asks to run; a write is never carried.
        val proposed = Extract.extractSql(answer)?.sql?.trim()
        // Read-only is not enough to be worth handing back: prose is not held to the hallucination
        // floor the ask path applies, so the names it used may not exist.
        val proposedSql = proposed?.takeIf {
            val verdict = SqlGuard.guard(it, Dialects.of(descriptor.engine), policy)
            verdict.allowed &&
                HallucinationChecks.firstUnknownTable(it, fullCatalog, verdict.tables) == null &&
                HallucinationChecks.firstUnknownColumn(it, fullCatalog) == null
        }
        return Scope.SchemaAnswer(answer, tables, unknown.isEmpty(), unknown, isSchemaChange, proposedSql)
    }

    private fun auditEntry(
        connectionId: String,
        question: String?,
        sql: String,
        status: HistoryStatus,
        errorCode: String? = null,
        durationMs: Long? = null,
        rowCount: Int? = null,
    ) = HistoryEntry(
        id = newHistoryId(),
        at = java.time.Instant.now(),
        connectionId = connectionId,
        question = question,
        sql = sql,
        status = status,
        errorCode = errorCode,
        durationMs = durationMs,
        rowCount = rowCount,
    )
}
