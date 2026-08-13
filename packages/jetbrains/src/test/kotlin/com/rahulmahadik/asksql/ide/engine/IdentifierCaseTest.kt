package com.rahulmahadik.asksql.ide.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors packages/core/test/identifier-case.test.ts; the two must agree. */
class IdentifierCaseTest {

    private val tables = listOf("Customers", "OrderItems")

    private fun fix(sql: String, quote: Char = '`') = IdentifierCase.correctTableCase(sql, tables, quote)

    @Test fun `corrects a lower-cased table name`() {
        assertEquals("SELECT * FROM `Customers`", fix("SELECT * FROM customers"))
    }

    @Test fun `corrects an upper-cased table name after JOIN`() {
        assertEquals(
            "SELECT * FROM Customers c JOIN `OrderItems` o ON c.id = o.id",
            fix("SELECT * FROM Customers c JOIN ORDERITEMS o ON c.id = o.id"),
        )
    }

    @Test fun `leaves an alias after the table alone`() {
        assertEquals("SELECT * FROM `OrderItems` oi", fix("SELECT * FROM orderitems oi"))
    }

    @Test fun `returns null when every name already matches`() {
        assertNull(fix("SELECT * FROM Customers"))
    }

    @Test fun `quotes with the dialect character`() {
        assertEquals("""SELECT * FROM "Customers"""", fix("SELECT * FROM customers", '"'))
    }

    @Test fun `corrects a name that was already quoted in the wrong case`() {
        assertEquals("SELECT * FROM `Customers`", fix("SELECT * FROM `customers`"))
    }

    @Test fun `keeps a schema prefix and corrects only the table`() {
        assertEquals("SELECT * FROM shop.`OrderItems`", fix("SELECT * FROM shop.orderitems"))
    }

    /** A column sharing a table's name must not be rewritten: it is not in table position. */
    @Test fun `leaves a same-named column alone`() {
        assertNull(fix("SELECT customers FROM Customers"))
    }

    /** Rewriting inside a literal would change the query's meaning, not just its spelling. */
    @Test fun `leaves a string literal alone`() {
        assertNull(fix("SELECT * FROM Customers WHERE note = 'from customers'"))
    }

    @Test fun `leaves a comment alone`() {
        assertNull(fix("SELECT * FROM Customers -- from customers"))
    }

    /** Two tables differing only by case have no single right answer. */
    @Test fun `leaves an ambiguous fold untouched`() {
        assertNull(IdentifierCase.correctTableCase("SELECT * FROM orders", listOf("Orders", "ORDERS"), '`'))
    }

    @Test fun `corrects an UPDATE target`() {
        assertEquals("UPDATE `Customers` SET x = 1", fix("UPDATE customers SET x = 1"))
    }

    @Test fun `leaves an unknown table alone`() {
        assertNull(fix("SELECT * FROM invoices"))
    }

    @Test fun `recognises every engine's unknown-table wording`() {
        for (message in listOf(
            "Table 'asksql_test.customers' doesn't exist",
            """relation "customers" does not exist""",
            "no such table: customers",
            "ORA-00942: table or view does not exist",
            "Invalid object name customers.",
        )) {
            assertTrue(message, IdentifierCase.looksLikeUnknownTable(message))
        }
        assertFalse(IdentifierCase.looksLikeUnknownTable("Unknown column x in field list"))
    }

    /** Postgres folds an unquoted name to lower case, so a mixed-case table needs quoting even when spelled right. */
    @Test fun `quotes a correctly spelled mixed-case table on Postgres`() {
        assertEquals(
            """SELECT * FROM "Customers"""",
            IdentifierCase.correctTableCase("SELECT * FROM Customers", tables, '"', IdentifierCase.Folding.LOWER),
        )
    }

    @Test fun `leaves a name the fold already resolves alone on Postgres`() {
        assertNull(IdentifierCase.correctTableCase("SELECT * FROM Orders", listOf("orders"), '"', IdentifierCase.Folding.LOWER))
    }

    @Test fun `leaves an already quoted mixed-case name alone on Postgres`() {
        assertNull(IdentifierCase.correctTableCase("""SELECT * FROM "Customers"""", tables, '"', IdentifierCase.Folding.LOWER))
    }

    @Test fun `quotes a mixed-case table on Oracle, which folds upper`() {
        assertEquals(
            """SELECT * FROM "MixedCase"""",
            IdentifierCase.correctTableCase("SELECT * FROM MixedCase", listOf("MixedCase"), '"', IdentifierCase.Folding.UPPER),
        )
    }

    @Test fun `leaves an upper-case Oracle table alone`() {
        assertNull(IdentifierCase.correctTableCase("SELECT * FROM employees", listOf("EMPLOYEES"), '"', IdentifierCase.Folding.UPPER))
    }

    private val quotable = listOf("Customers", "OrderItems", "FirstName", "Country", "CustomerId")
    private fun q(sql: String) = IdentifierCase.quoteCatalogIdentifiers(sql, quotable, '"')

    @Test fun `quotes both the table and the columns`() {
        assertEquals(
            """SELECT "FirstName" FROM "Customers" WHERE "Country" = 'UK'""",
            q("""SELECT FirstName FROM Customers WHERE Country = 'UK'"""),
        )
    }

    @Test fun `quotes a qualified column`() {
        assertEquals("""SELECT c."CustomerId" FROM "Customers" c""", q("SELECT c.CustomerId FROM Customers c"))
    }

    /** Doubling the quotes would make the identifier unreadable. */
    @Test fun `leaves an already quoted identifier alone when quoting`() {
        assertNull(q("""SELECT "FirstName" FROM "Customers""""))
    }

    /** A reserved word used as a function must not become an identifier. */
    @Test fun `leaves a function call alone`() {
        assertEquals(
            """SELECT COUNT(*) FROM "Customers"""",
            IdentifierCase.quoteCatalogIdentifiers("SELECT COUNT(*) FROM Customers", listOf("Customers", "count"), '"'),
        )
    }

    @Test fun `leaves a string literal alone when quoting`() {
        assertNull(q("""SELECT 1 WHERE x = 'FirstName'"""))
    }

    /** A table called "order" once turned ORDER BY into "order" BY, which the guard then rejected. */
    @Test fun `does not rewrite a keyword that is not naming the table`() {
        assertEquals(
            """SELECT x FROM "Customers" ORDER BY x DESC""",
            IdentifierCase.quoteCatalogIdentifiers("SELECT x FROM Customers ORDER BY x DESC", listOf("Customers", "order"), '"'),
        )
    }

    @Test fun `still quotes GROUP BY and other keyword-adjacent columns`() {
        assertEquals(
            """SELECT "Country" FROM t GROUP BY "Country"""",
            IdentifierCase.quoteCatalogIdentifiers("SELECT Country FROM t GROUP BY Country", listOf("Country"), '"'),
        )
    }

    /** A table called Nulls broke the parser: NULLS is a keyword, so the bare name would not parse. */
    @Test fun `quotes a table named like a parser keyword`() {
        assertEquals(
            """SELECT "Val" FROM "Nulls"""",
            IdentifierCase.quoteCatalogIdentifiers("SELECT Val FROM Nulls", listOf("Nulls", "Val"), '"'),
        )
    }

    @Test fun `quotes a table whose name is a reserved word`() {
        assertEquals("""SELECT * FROM "order"""", IdentifierCase.quoteCatalogIdentifiers("SELECT * FROM order", listOf("order"), '"'))
    }

    @Test fun `returns null when nothing needs quoting`() {
        assertNull(IdentifierCase.quoteCatalogIdentifiers("SELECT id FROM orders", emptyList(), '"'))
    }

    private val syntaxNames = listOf("Date", "Status", "Orders", "Month", "Amount", "order")
    private fun qs(sql: String) = IdentifierCase.quoteCatalogIdentifiers(sql, syntaxNames, '"')

    /** Quoting the type turns CAST(x AS DATE) into a reference to a column that does not exist. */
    @Test fun `leaves the type in a CAST alone`() {
        assertNull(qs("SELECT CAST(x AS Date) FROM t"))
    }

    /** EXTRACT's first argument is a field keyword; the source after FROM is a real column. */
    @Test fun `quotes the source of an EXTRACT but not the field`() {
        assertEquals("""SELECT EXTRACT(month FROM "Date") FROM t""", qs("SELECT EXTRACT(month FROM Date) FROM t"))
    }

    @Test fun `leaves the leading keyword of a TRIM alone`() {
        assertEquals("""SELECT TRIM(both 'x' FROM "Status") FROM t""", qs("SELECT TRIM(both 'x' FROM Status) FROM t"))
    }

    @Test fun `still quotes a reserved word in table position`() {
        assertEquals("""SELECT * FROM "order"""", qs("SELECT * FROM order"))
    }

    @Test fun `still quotes a reserved word qualified by a dot`() {
        assertEquals("""SELECT t."order" FROM t""", qs("SELECT t.order FROM t"))
    }

    @Test fun `still quotes an ordinary column inside a function call`() {
        assertEquals("""SELECT COUNT("Amount") FROM "Orders"""", qs("SELECT COUNT(Amount) FROM Orders"))
    }

    /** A doubled quote is SQL's escaped apostrophe; treating it as the close rewrote text inside the value. */
    @Test fun `does not rewrite identifiers inside a literal containing an escaped quote`() {
        assertEquals(
            """SELECT * FROM "Orders" WHERE note = 'it''s about Status'""",
            IdentifierCase.quoteCatalogIdentifiers(
                "SELECT * FROM Orders WHERE note = 'it''s about Status'", listOf("Orders"), '"',
            ),
        )
    }

    /** 'O'Brien' is what a model writes when it forgets to double the apostrophe. */
    @Test fun `spots an unescaped apostrophe`() {
        assertTrue(IdentifierCase.hasUnterminatedLiteral("SELECT Note FROM Person WHERE Name = 'O'Brien'"))
    }

    @Test fun `accepts a correctly doubled apostrophe`() {
        assertFalse(IdentifierCase.hasUnterminatedLiteral("SELECT Note FROM Person WHERE Name = 'O''Brien'"))
    }

    @Test fun `accepts ordinary statements`() {
        for (sql in listOf(
            "SELECT * FROM t WHERE a = 'x' AND b = 'y'",
            "SELECT * FROM t",
            "SELECT * FROM t -- it's fine",
            "SELECT * FROM t /* it's fine */",
        )) {
            assertFalse(sql, IdentifierCase.hasUnterminatedLiteral(sql))
        }
    }

    @Test fun `spots a value that runs off the end`() {
        assertTrue(IdentifierCase.hasUnterminatedLiteral("SELECT * FROM t WHERE a = 'oops"))
    }

    private val litNames = listOf("Users", "Notes", "Sales")

    /** Postgres and DuckDB dollar-quote bodies, which may contain anything at all. */
    @Test fun `leaves a dollar-quoted body alone`() {
        val d = "\u0024\u0024" // a dollar-quote delimiter, written as escapes so Kotlin sees no template
        assertEquals(
            "SELECT * FROM \"Users\" WHERE \"Notes\" = ${d}from users now$d",
            IdentifierCase.quoteCatalogIdentifiers("SELECT * FROM Users WHERE Notes = ${d}from users now$d", litNames, '"'),
        )
    }

    /** Quoting a schema qualifier turns a working query into "schema does not exist". */
    @Test fun `does not quote a qualifier that is not a table`() {
        assertNull(IdentifierCase.quoteCatalogIdentifiers("SELECT * FROM sales.orders", listOf("Sales"), '"', emptyList()))
    }

    @Test fun `still quotes a qualifier that is a real table`() {
        assertEquals(
            """SELECT "Customers"."FirstName" FROM "Customers"""",
            IdentifierCase.quoteCatalogIdentifiers(
                "SELECT Customers.FirstName FROM Customers", listOf("Customers", "FirstName"), '"', listOf("Customers"),
            ),
        )
    }

    /** In prod.sales.orders the table is orders; sales is a qualifier. */
    @Test fun `does not recase the middle of a three-part name`() {
        assertNull(IdentifierCase.correctTableCase("SELECT * FROM prod.sales.orders", listOf("Sales"), '"', IdentifierCase.Folding.LOWER))
    }

    private val BS = "\u005c" // a single backslash

    /** Backslash escapes a quote in MySQL only; the other engines read it literally. */
    @Test fun `treats a backslash as an escape only for the backtick dialect`() {
        val sql = "SELECT * FROM t WHERE n = 'O${BS}'Brien'"
        assertFalse(IdentifierCase.hasUnterminatedLiteral(sql, true))
        assertTrue(IdentifierCase.hasUnterminatedLiteral(sql))
    }

    /** A dollar-quoted body needs no escaping, so an apostrophe inside it is not a defect. */
    @Test fun `does not flag an apostrophe inside a dollar-quoted body`() {
        val d = "\u0024\u0024"
        assertFalse(IdentifierCase.hasUnterminatedLiteral("SELECT * FROM t WHERE n = ${d}don't$d"))
    }

    /** TIMESTAMP '2024-01-01' is one typed literal; quoting the word makes it a missing column. */
    @Test fun `leaves a typed literal alone`() {
        assertNull(
            IdentifierCase.quoteCatalogIdentifiers(
                "SELECT * FROM t WHERE created > TIMESTAMP '2024-01-01'", listOf("Timestamp"), '"',
            ),
        )
    }

    @Test fun `still quotes the same word used as a real column`() {
        assertEquals(
            "SELECT \"Timestamp\" FROM t",
            IdentifierCase.quoteCatalogIdentifiers("SELECT Timestamp FROM t", listOf("Timestamp"), '"'),
        )
    }

    private val boundaryNames = listOf("Customers", "FirstName", "Country", "City", "Timestamp")

    /**
     * Literals split the statement into segments, and the typed-literal check reads the whole
     * statement rather than one segment. If it read the segment, every name sitting at a segment
     * boundary would silently stop being quoted.
     */
    @Test fun `quotes names before, between and after several literals`() {
        assertEquals(
            "SELECT \"FirstName\" FROM \"Customers\" WHERE \"Country\" = 'UK' AND \"City\" = 'York'",
            IdentifierCase.quoteCatalogIdentifiers(
                "SELECT FirstName FROM Customers WHERE Country = 'UK' AND City = 'York'", boundaryNames, '"',
            ),
        )
    }

    /** The one word that must not be quoted is the one a literal directly follows. */
    @Test fun `skips only the typed literal, quoting every other name`() {
        assertEquals(
            "SELECT \"FirstName\" FROM \"Customers\" WHERE created > TIMESTAMP '2024-01-01'",
            IdentifierCase.quoteCatalogIdentifiers(
                "SELECT FirstName FROM Customers WHERE created > TIMESTAMP '2024-01-01'", boundaryNames, '"',
            ),
        )
    }
}
