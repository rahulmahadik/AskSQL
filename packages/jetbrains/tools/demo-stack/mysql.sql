-- ============================================================================
-- AskSQL JetBrains live tests - MERGED MySQL fixture (localhost:53306)
--
-- Serves, in one database, every MySQL-backed assertion in:
--   engine/MySqlEndToEndTest.kt                       (4 tests)
--   engine/EnginePipelineCatalogTimingTest.kt         (2 tests)
--   db/JdbcConnectionFactoryLiveTimingTest.kt         (1 test)
--   engine/EdgeCaseAccuracyEvalTest.kt                (mysql edge cases)
--   engine/FailedQuestionsRetestTest.kt               (mysql truth SQL, run OUTSIDE try/catch)
--   db/introspect/MySqlBatchedIntrospectionLiveTest.kt (needs NO fixture - see bottom)
--
-- Load:
--   mysql -h 127.0.0.1 -P 53306 -u root < asksql-demo-mysql.sql
--
-- Do NOT also load packages/mysql/test/fixture.sql: it targets database
-- asksql_test on port 3306 and builds an unrelated shops/products/in_stock set
-- (plus a trigger that can need --log-bin-trust-function-creators).
-- ============================================================================

CREATE DATABASE IF NOT EXISTS asksql_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE asksql_demo;

-- MySQL 8.4's shipped sql_mode is
--   ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,
--   ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION
-- (verified on the running container), which makes the '0000-00-00 00:00:00'
-- INSERT below a hard error. Cleared for THIS LOADING SESSION only; the server
-- default is untouched and the plugin's read path does not depend on sql_mode.
SET SESSION sql_mode = '';

-- Children first: both FKs below are declared, so drop order matters.
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS signups;
DROP TABLE IF EXISTS user_permissions;

-- ---------------------------------------------------------------------------
-- customers / orders / order_items
--
-- customers: MySqlEndToEndTest.kt:61 "How many customers are there in total?"
--   -> :67 SELECT assertion, :70 rows.isNotEmpty(). The table NAME is enforced by
--   EnginePipeline's hallucination floor (EnginePipeline.kt:297-311).
-- The `id`/`name` columns and orders/order_items are HARD requirements of
--   FailedQuestionsRetestTest.kt:138, whose truth SQL
--     SELECT COUNT(DISTINCT oi.product_name) FROM customers c
--       JOIN orders o ON o.customer_id=c.id JOIN order_items oi ON oi.order_id=o.id
--       WHERE c.name='Alice Johnson'
--   runs at :94 OUTSIDE the try block; anything missing throws out of runOne.
-- Shape is kept byte-identical to the Postgres fixture so the one shared case
-- list (EdgeCaseAccuracyEvalTest.kt:83-95) means the same thing on both engines.
-- Explicit ids, no AUTO_INCREMENT: the truth SQL joins on c.id.
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id    INT PRIMARY KEY,
  name  VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE orders (
  id           INT PRIMARY KEY,
  customer_id  INT NOT NULL,
  total_cents  INT NOT NULL,
  status       VARCHAR(20) NOT NULL COMMENT 'One of: completed, pending',
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB;

CREATE TABLE order_items (
  id                INT PRIMARY KEY,
  order_id          INT NOT NULL,
  product_name      VARCHAR(120) NOT NULL,
  quantity          INT NOT NULL,
  unit_price_cents  INT NOT NULL,
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

INSERT INTO customers (id, name, email) VALUES
  (1, 'Alice Johnson', 'alice@example.com'),
  (2, 'Bob Smith',     'bob@example.com'),
  (3, 'Carol White',   'carol@example.com');

-- Identical to the Postgres fixture and to the in-test DuckDB twin
-- (EdgeCaseAccuracyEvalTest.kt:185). Sum = 13600 (EdgeCaseAccuracyEvalTest.kt:88).
INSERT INTO orders (id, customer_id, total_cents, status) VALUES
  (1, 1, 2500, 'completed'),
  (2, 1, 1200, 'pending'),
  (3, 2, 9900, 'completed');

-- Reconciles per order to total_cents; makes Alice's distinct-product count
-- deterministic at 2 (Widget, Gadget) for FailedQuestionsRetestTest.kt:138.
INSERT INTO order_items (id, order_id, product_name, quantity, unit_price_cents) VALUES
  (1, 1, 'Widget', 1,  400),
  (2, 1, 'Gadget', 3,  700),
  (3, 2, 'Widget', 3,  400),
  (4, 3, 'Widget', 5,  400),
  (5, 3, 'Gadget', 1,  700),
  (6, 3, 'Gizmo',  6, 1200);

-- ---------------------------------------------------------------------------
-- signups
--   Hit by LITERAL SQL, so the table name and BOTH column names must match
--   character for character:
--     MySqlEndToEndTest.kt:86   SELECT username, last_login FROM signups WHERE username = 'bob'
--     MySqlEndToEndTest.kt:101  SELECT username, last_login FROM signups WHERE username = 'carol'
--   last_login must be DATETIME (Types.TIMESTAMP -> JdbcExecutor's getString()
--   branch, which ignores wasNull(), so the zero date reads back as
--   CellValue.Text starting "0000-00-00" -- MySqlEndToEndTest.kt:89-92) and
--   NULLable, so carol's genuine NULL still reads as CellValue.Null (:103).
-- ---------------------------------------------------------------------------
CREATE TABLE signups (
  id          INT PRIMARY KEY,
  username    VARCHAR(64) NOT NULL UNIQUE,
  last_login  DATETIME NULL DEFAULT NULL
) ENGINE=InnoDB;

INSERT INTO signups (id, username, last_login) VALUES
  (1, 'alice', '2024-05-01 09:15:00'),   -- ordinary value, not asserted on
  (2, 'bob',   '0000-00-00 00:00:00'),   -- MySqlEndToEndTest.kt:89-92
  (3, 'carol', NULL);                    -- MySqlEndToEndTest.kt:103

-- ---------------------------------------------------------------------------
-- user_permissions
--   MySqlEndToEndTest.kt:113 "What are the permission flags for the user named
--   alice, in the user_permissions table?" -> :114 SELECT assertion,
--   :117 rows.isNotEmpty(). The table name is named literally in the question and
--   enforced by the hallucination floor. BIT(8), not BIT(1), for the same
--   isSingleBit() reason as the Postgres `permissions` table.
--
--   NO capitalised duplicate row here, unlike the Postgres fixture. This database
--   is utf8mb4_0900_ai_ci, so `WHERE username='Alice'` ALREADY matches the stored
--   'alice'; adding an 'Alice' row makes the load fail with
--   "ERROR 1062 Duplicate entry 'Alice' for key 'user_permissions.username'".
--   Postgres text comparison is case-sensitive, which is why the hedge is needed
--   there and forbidden here.
-- ---------------------------------------------------------------------------
CREATE TABLE user_permissions (
  id        INT PRIMARY KEY,
  username  VARCHAR(64) NOT NULL UNIQUE,
  flags     BIT(8) NOT NULL
) ENGINE=InnoDB;

INSERT INTO user_permissions (id, username, flags) VALUES
  (1, 'alice', b'10110101'),
  (2, 'bob',   b'00000011');

-- ---------------------------------------------------------------------------
-- Nothing is created for MySqlBatchedIntrospectionLiveTest: it DROP/CREATEs
-- database asksql_batch_introspect_test and its own foo_bar/fooxbar/orders in
-- @Before (:45-54) and drops the database in @After (:63). MySqlIntrospector
-- scopes every query to connection.catalog (MySqlIntrospector.kt:16-17,31,45),
-- so asksql_demo.orders above is invisible to it and cannot break its
-- `catalog.tables.first { it.name == "orders" }` lookup (:84).
-- It only needs root to be able to CREATE and DROP a database.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Self-check. Every column must read 1 / OK.
-- ---------------------------------------------------------------------------
SELECT
  (SELECT COUNT(*) FROM customers) = 3                                     AS customers_is_3,
  (SELECT SUM(total_cents) FROM orders) = 13600                            AS order_total_is_13600,
  (SELECT COUNT(*) FROM orders WHERE status='completed') >= 1              AS has_completed_order,
  (SELECT COUNT(*) FROM user_permissions WHERE username='alice') = 1       AS has_alice_perms,
  (SELECT COUNT(*) FROM signups WHERE username='carol' AND last_login IS NULL) = 1 AS carol_is_null,
  (SELECT COUNT(*) FROM user_permissions WHERE username='Alice') = 1        AS capital_alice_also_matches,
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='asksql_demo') AS table_count;

-- The single most fragile fact in this file: if strict/NO_ZERO_DATE were still in
-- force the INSERT above would have errored or been coerced, and
-- MySqlEndToEndTest.kt:89-92 would fail with a confusing "got Null".
SELECT IF(
  (SELECT CAST(last_login AS CHAR) FROM signups WHERE username='bob') LIKE '0000-00-00%',
  'OK: zero-value DATETIME stored',
  'FIXTURE ERROR: signups.bob.last_login is not a zero date - check sql_mode'
) AS zero_date_check;

-- Truth SQL from FailedQuestionsRetestTest.kt:138, executed here so a fixture
-- defect surfaces now rather than as an escaped exception inside the eval.
SELECT COUNT(DISTINCT oi.product_name) AS alice_distinct_products
FROM customers c JOIN orders o ON o.customer_id=c.id JOIN order_items oi ON oi.order_id=o.id
WHERE c.name='Alice Johnson';
