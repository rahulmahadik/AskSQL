package com.rahulmahadik.asksql.ide.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.DriverProvisioner
import com.rahulmahadik.asksql.ide.errors.ErrorPresenter
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.settings.AskSqlProjectSettings
import com.rahulmahadik.asksql.ide.settings.AskSqlSettingsListener
import com.rahulmahadik.asksql.ide.settings.toState
import com.rahulmahadik.asksql.ide.util.withHardTimeout
import kotlinx.coroutines.runBlocking
import java.nio.file.Files
import java.nio.file.Path
import java.util.Properties
import java.util.concurrent.atomic.AtomicBoolean

/** Materializes a small demo SQLite database and registers it as a connection, regenerated on every run. */
class TrySampleDataAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) {
        val project = e.project ?: return
        createSampleConnection(project) {}
    }

    companion object {
        private const val SAMPLE_CONNECTION_ID = "asksql-sample-shop"

        /** Guards against a double-click launching two concurrent seeds against the same file. */
        private val creationInFlight = AtomicBoolean(false)

        fun createSampleConnection(project: Project, onCreated: () -> Unit) {
            if (!creationInFlight.compareAndSet(false, true)) {
                ErrorPresenter.notifyInfo(project, "Already creating the sample database - hang on a moment.")
                return
            }
            // Real progress row in the status bar instead of a silent background coroutine.
            ProgressManager.getInstance().run(
                object : Task.Backgroundable(project, "AskSQL: creating sample database", true) {
                    override fun run(indicator: ProgressIndicator) {
                        indicator.isIndeterminate = true
                        indicator.text = "AskSQL: seeding demo tables (customers, products, orders)…"
                        try {
                            val path = runBlocking { withHardTimeout(15_000) { materializeSampleDatabase() } }
                            val descriptor = ConnectionDescriptor(
                                id = SAMPLE_CONNECTION_ID,
                                name = "Sample: Shop (demo data)",
                                engine = EngineKind.SQLITE,
                                scope = ConnectionScope.PROJECT,
                                filePath = path.toString(),
                                isSample = true,
                            )
                            val settings = AskSqlProjectSettings.getInstance(project)
                            if (settings.connections.none { it.id == SAMPLE_CONNECTION_ID }) {
                                settings.connections = settings.connections + descriptor.toState()
                            }
                            project.getService(ConnectionRegistry::class.java).invalidate(SAMPLE_CONNECTION_ID)
                            ApplicationManager.getApplication().invokeLater {
                                ApplicationManager.getApplication().messageBus.syncPublisher(AskSqlSettingsListener.TOPIC).settingsChanged()
                                onCreated()
                            }
                        } catch (ex: Exception) {
                            ApplicationManager.getApplication().invokeLater { ErrorPresenter.notify(project, ex) }
                        }
                    }

                    override fun onFinished() {
                        creationInFlight.set(false)
                    }
                },
            )
        }

        /** Creates a small shop-style SQLite database with FKs, for onboarding. */
        internal fun materializeSampleDatabase(): Path {
            val dir = Path.of(PathManager.getSystemPath(), "asksql", "sample")
            Files.createDirectories(dir)
            val file = dir.resolve("shop-demo.db")
            Files.deleteIfExists(file) // always regenerate, this is demo data

            // Direct (non-read-only) connection for the one-time seed write.
            val driver = DriverProvisioner.driverFor(EngineKind.SQLITE)
            driver.connect("jdbc:sqlite:$file", Properties()).use { connection ->
                connection.createStatement().use { st ->
                    st.executeUpdate(
                        """
                        CREATE TABLE customers (
                            id INTEGER PRIMARY KEY,
                            name TEXT NOT NULL,
                            email TEXT,
                            country TEXT
                        )
                        """.trimIndent(),
                    )
                    st.executeUpdate(
                        """
                        CREATE TABLE products (
                            id INTEGER PRIMARY KEY,
                            name TEXT NOT NULL,
                            category TEXT,
                            price_cents INTEGER NOT NULL
                        )
                        """.trimIndent(),
                    )
                    st.executeUpdate(
                        """
                        CREATE TABLE orders (
                            id INTEGER PRIMARY KEY,
                            customer_id INTEGER NOT NULL REFERENCES customers(id),
                            ordered_at TEXT NOT NULL,
                            status TEXT NOT NULL
                        )
                        """.trimIndent(),
                    )
                    st.executeUpdate(
                        """
                        CREATE TABLE order_items (
                            id INTEGER PRIMARY KEY,
                            order_id INTEGER NOT NULL REFERENCES orders(id),
                            product_id INTEGER NOT NULL REFERENCES products(id),
                            quantity INTEGER NOT NULL,
                            unit_price_cents INTEGER NOT NULL
                        )
                        """.trimIndent(),
                    )

                    val customers = listOf(
                        "1,'Ava Chen','ava@example.com','US'", "2,'Liam Smith','liam@example.com','GB'",
                        "3,'Noor Ahmed','noor@example.com','AE'", "4,'Mateo Rossi','mateo@example.com','IT'",
                        "5,'Yuki Tanaka','yuki@example.com','JP'",
                    )
                    customers.forEach { st.executeUpdate("INSERT INTO customers VALUES ($it)") }

                    val products = listOf(
                        "1,'Mechanical Keyboard','Electronics',8900", "2,'Standing Desk','Furniture',34900",
                        "3,'Wireless Mouse','Electronics',2900", "4,'Desk Lamp','Furniture',1900",
                        "5,'Noise Cancelling Headphones','Electronics',19900",
                    )
                    products.forEach { st.executeUpdate("INSERT INTO products VALUES ($it)") }

                    val orders = listOf(
                        "1,1,'2026-06-01','shipped'", "2,2,'2026-06-03','shipped'",
                        "3,1,'2026-06-10','pending'", "4,3,'2026-06-12','shipped'",
                        "5,4,'2026-06-14','cancelled'", "6,5,'2026-06-15','shipped'",
                    )
                    orders.forEach { st.executeUpdate("INSERT INTO orders VALUES ($it)") }

                    val items = listOf(
                        "1,1,1,1,8900", "2,1,3,2,2900", "3,2,2,1,34900", "4,3,5,1,19900",
                        "5,4,1,1,8900", "6,4,4,2,1900", "7,6,3,1,2900", "8,6,5,1,19900",
                    )
                    items.forEach { st.executeUpdate("INSERT INTO order_items VALUES ($it)") }
                }
            }
            return file
        }
    }
}
