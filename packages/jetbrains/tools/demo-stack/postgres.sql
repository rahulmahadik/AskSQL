-- ============================================================================
-- AskSQL JetBrains live tests - MERGED Postgres fixture (localhost:55432)
--
-- Serves, in one database, every Postgres-backed assertion in:
--   engine/PostgresEndToEndTest.kt                    (5 tests)
--   engine/EdgeCaseAccuracyEvalTest.kt                (postgres edge cases + row cap)
--   engine/FailedQuestionsRetestTest.kt               (postgres truth SQL, run OUTSIDE try/catch)
--   db/introspect/PostgresBatchedIntrospectionLiveTest.kt (needs NO fixture - see bottom)
--
-- Load:
--   psql -v ON_ERROR_STOP=1 -h localhost -p 55432 -U asksql -d asksql_demo \
--        -f asksql-demo-postgres.sql
--
-- Everything lives in schema `public`. That is load-bearing:
--   * CatalogPruner.kt:55-59 only schema-qualifies table names when the catalog has
--     more than one schema, and PostgresIntrospector.kt:15-16 keeps EVERY non-system
--     schema. A second user schema would silently switch the whole prompt to
--     "public.customers" form.
--   * PostgresEndToEndTest.kt:129 runs `... FROM "Products" ...` unqualified.
-- Do NOT also load packages/postgres/test/fixture.sql here: it builds a `shop`
-- schema with a SECOND customers/orders/order_items trio under different column
-- names (full_name/sku/qty) and an order_status enum with no 'completed' label.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

DROP TABLE IF EXISTS public.order_items CASCADE;
DROP TABLE IF EXISTS public.orders      CASCADE;
DROP TABLE IF EXISTS public.customers   CASCADE;
DROP TABLE IF EXISTS public.events      CASCADE;   -- drops its partitions with it
DROP TABLE IF EXISTS public."Products"  CASCADE;
DROP TABLE IF EXISTS public.permissions CASCADE;

-- ---------------------------------------------------------------------------
-- customers / orders / order_items
--
-- customers+orders: PostgresEndToEndTest.kt:61 ("How many completed orders are
--   there?" -> :70 rows.isNotEmpty()) and :86 ("...name alongside the total_cents
--   of their orders." -> :94 rows.isNotEmpty()).
-- order_items: FailedQuestionsRetestTest.kt:151/:155/:159 truth SQL, executed at
--   :94 OUTSIDE the try block - a missing table or column throws out of runOne and
--   fails the test outright. Column names are verbatim from those statements.
-- customers.name (not full_name): FailedQuestionsRetestTest.kt:138 `c.name`.
--
-- status is TEXT, deliberately not an enum: an enum lacking the exact label the
-- model writes turns `status = '...'` into SQLSTATE 22P02, which EnginePipeline
-- maps to DB_QUERY_ERROR and fails PostgresEndToEndTest.kt:70.
-- ---------------------------------------------------------------------------
CREATE TABLE public.customers (
  id     integer PRIMARY KEY,
  name   text    NOT NULL,
  email  text    NOT NULL
);

CREATE TABLE public.orders (
  id           integer PRIMARY KEY,
  customer_id  integer NOT NULL REFERENCES public.customers(id),
  total_cents  integer NOT NULL,
  status       text    NOT NULL
);

CREATE TABLE public.order_items (
  id                integer PRIMARY KEY,
  order_id          integer NOT NULL REFERENCES public.orders(id),
  product_name      text    NOT NULL,
  quantity          integer NOT NULL,
  unit_price_cents  integer NOT NULL
);

INSERT INTO public.customers (id, name, email) VALUES
  (1, 'Alice Johnson', 'alice@example.com'),
  (2, 'Bob Smith',     'bob@example.com'),
  (3, 'Carol White',   'carol@example.com');

-- Customer/total assignment copied EXACTLY from the in-test DuckDB twin of this
-- fixture (EdgeCaseAccuracyEvalTest.kt:185), which is the only in-repo statement
-- of the intended shape. 2500+1200+9900 = 13600 (EdgeCaseAccuracyEvalTest.kt:88).
-- Two 'completed' rows satisfy PostgresEndToEndTest.kt:70 even if the model
-- answers with `SELECT *` instead of `COUNT(*)`.
INSERT INTO public.orders (id, customer_id, total_cents, status) VALUES
  (1, 1, 2500, 'completed'),
  (2, 1, 1200, 'pending'),
  (3, 2, 9900, 'completed');

-- Items reconcile per order to total_cents (400+2100=2500 | 1200 | 2000+700+7200=9900)
-- and make Widget the UNIQUE winner of "which product appears in the greatest number
-- of distinct orders" (FailedQuestionsRetestTest.kt:154-156), whose truth SQL is
-- non-deterministic on a tie: Widget 3 orders, Gadget 2, Gizmo 1.
INSERT INTO public.order_items (id, order_id, product_name, quantity, unit_price_cents) VALUES
  (1, 1, 'Widget', 1,  400),
  (2, 1, 'Gadget', 3,  700),
  (3, 2, 'Widget', 3,  400),
  (4, 3, 'Widget', 5,  400),
  (5, 3, 'Gadget', 1,  700),
  (6, 3, 'Gizmo',  6, 1200);

-- HEDGE, not a recovered requirement -- delete these two lines to get the minimal
-- fixture. No SQL introspector populates ColumnInfo.sampledValues (only
-- MongoIntrospector.kt:113 does), so on Postgres the model never sees the literal
-- 'completed' in the schema block. PostgresIntrospector.columnComments feeds
-- CatalogPruner.kt:83-84, which renders "-- <comment>" after the column, so a
-- comment is the one channel that puts the literal in front of the model without
-- the enum's 22P02 risk.
COMMENT ON COLUMN public.orders.status IS 'One of: completed, pending';

-- ---------------------------------------------------------------------------
-- events: a declaratively partitioned parent with real partitions
--   PostgresEndToEndTest.kt:112 "How many rows are in the events table?" -> :116.
-- The parent must be relkind 'p' so pgjdbc reports TABLE_TYPE "PARTITIONED TABLE"
-- (CommonIntrospection.kt:48) and PostgresIntrospector.partitionMeta flags it;
-- CatalogPruner.kt:63 then collapses the children into the parent, so the two
-- partitions cost nothing in the prompt. Rows in BOTH partitions make the test's
-- "across its partitions" (:108) real and keep a `SELECT *` answer non-empty.
-- ---------------------------------------------------------------------------
CREATE TABLE public.events (
  id          bigint NOT NULL,
  created_at  date   NOT NULL,
  payload     text
) PARTITION BY RANGE (created_at);

CREATE TABLE public.events_2024 PARTITION OF public.events
  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE public.events_2025 PARTITION OF public.events
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

INSERT INTO public.events (id, created_at, payload) VALUES
  (1, DATE '2024-03-01', 'signup'),
  (2, DATE '2024-07-14', 'login'),
  (3, DATE '2025-01-05', 'purchase'),
  (4, DATE '2025-06-30', 'logout');

-- ---------------------------------------------------------------------------
-- "Products": mixed-case, quoted identifiers
--   PostgresEndToEndTest.kt:129 runs this statement VERBATIM:
--     SELECT "productName", "Price" FROM "Products" WHERE "productName" = 'Widget'
--   -> :130 rows.isNotEmpty().
-- EnginePipeline.execute (EnginePipeline.kt:361-402) runs SqlGuard only, no
-- hallucination check, so this is a pure DB requirement: the identifiers must be
-- created quoted (to keep their case) and resolve on the default search_path.
-- ---------------------------------------------------------------------------
CREATE TABLE public."Products" (
  id            integer PRIMARY KEY,
  "productName" text          NOT NULL,
  "Price"       numeric(10,2) NOT NULL
);

INSERT INTO public."Products" (id, "productName", "Price") VALUES
  (1, 'Widget',  9.99),
  (2, 'Gadget', 24.50);

-- ---------------------------------------------------------------------------
-- permissions: multi-bit bit(n)
--   PostgresEndToEndTest.kt:139 "What are the permission flags for the user named
--   alice, in the permissions table?" -> :143 rows.isNotEmpty().
-- bit(8), not bit(1): JdbcExecutor.kt:154/:179 sends a single-bit column down the
-- Boolean branch and a multi-bit one down getString()->CellValue.Text, and the
-- test at :133 is about the multi-bit case.
-- Both 'alice' and 'Alice' are seeded so a capitalised WHERE still matches.
-- ---------------------------------------------------------------------------
CREATE TABLE public.permissions (
  id       integer PRIMARY KEY,
  username text     NOT NULL,
  flags    bit(8)   NOT NULL
);

INSERT INTO public.permissions (id, username, flags) VALUES
  (1, 'alice', B'10100101'),
  (2, 'bob',   B'00000011'),
  (3, 'Alice', B'10100101');

COMMIT;

-- reltuples is -1 until analyzed; PostgresIntrospector.rowEstimates reads it and
-- CatalogPruner.kt:70 prints it as "[~N rows]". Cosmetic, not asserted.
ANALYZE public.customers;
ANALYZE public.orders;
ANALYZE public.order_items;
ANALYZE public.events;
ANALYZE public."Products";
ANALYZE public.permissions;

-- ---------------------------------------------------------------------------
-- Nothing is created for PostgresBatchedIntrospectionLiveTest: it DROP/CREATEs
-- schema asksql_batch_introspect_test and its own foo_bar/fooxbar/orders in
-- @Before (:49-58) and drops the schema in @After (:67). Its assertions filter on
-- `it.schema == SCHEMA` (:76-77, :88), so public.orders above cannot collide.
-- It only needs the asksql role to be able to CREATE and DROP a schema here.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Self-check. Every line must print t / the stated value.
-- ---------------------------------------------------------------------------
\echo '--- postgres fixture self-check ---'
SELECT
  (SELECT count(*) FROM public.customers) = 3                                   AS customers_is_3,
  (SELECT sum(total_cents) FROM public.orders) = 13600                          AS order_total_is_13600,
  (SELECT count(*) FROM public.orders WHERE status = 'completed') >= 1          AS has_completed_order,
  (SELECT count(*) FROM public."Products" WHERE "productName" = 'Widget') = 1   AS has_widget_row,
  (SELECT count(*) FROM public.permissions WHERE username = 'alice') = 1        AS has_alice_perms,
  (SELECT count(*) FROM public.events) = 4                                      AS events_rows_visible,
  (SELECT relkind FROM pg_class WHERE oid = 'public.events'::regclass) = 'p'    AS events_is_partitioned,
  (SELECT count(DISTINCT nspname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m')
       AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')) = 1 AS exactly_one_user_schema;

-- Every FailedQuestionsRetestTest truth SQL, run here so a fixture defect surfaces
-- now instead of as an opaque test failure 40 minutes into the eval.
\echo '--- truth SQL (FailedQuestionsRetestTest.kt:151, :155, :159) ---'
SELECT product_name, SUM(quantity*unit_price_cents) FROM order_items GROUP BY product_name ORDER BY product_name;
SELECT product_name FROM order_items GROUP BY product_name ORDER BY COUNT(DISTINCT order_id) DESC LIMIT 1;
SELECT oi.product_name, COUNT(DISTINCT o.customer_id) FROM order_items oi JOIN orders o ON o.id=oi.order_id GROUP BY oi.product_name ORDER BY 1;

-- Proves the privilege PostgresBatchedIntrospectionLiveTest.kt:49-50/:67 needs.
CREATE SCHEMA asksql_privcheck;
DROP SCHEMA asksql_privcheck;
\echo 'postgres fixture OK'
