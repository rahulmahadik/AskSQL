package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.dsl.builder.Row
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.db.JdbcConnectionFactory
import com.rahulmahadik.asksql.ide.db.MongoClientFactory
import com.rahulmahadik.asksql.ide.db.SslMode
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import com.rahulmahadik.asksql.ide.errors.ErrorPresenter
import com.rahulmahadik.asksql.ide.actions.UploadFileToDuckDbAction
import com.rahulmahadik.asksql.ide.integrations.database.DataSourceImporter
import com.rahulmahadik.asksql.ide.model.EngineKind
import com.rahulmahadik.asksql.ide.settings.AskSqlSecrets
import com.rahulmahadik.asksql.ide.util.runBlockingWithProgress
import java.util.UUID
import javax.swing.JComponent
import javax.swing.JPasswordField
import javax.swing.JTextField

/** Human-readable label for one importable data source, distinct even when two share a name. */
private fun DataSourceImporter.ImportedDataSource.label(): String =
    "$name (${engine.name.lowercase()}${host?.let { " - $it" } ?: ""})"

internal val MONGO_SCHEME_RE = Regex("""^mongodb(\+srv)?://""", RegexOption.IGNORE_CASE)

/**
 * True if a Mongo connection string embeds `user:pass@` before its first `/`; credentials belong in
 * the User/Password fields. `internal` so [ConnectionEditorDialogValidationTest] can cover it without a Swing fixture.
 */
internal fun mongoConnectionStringHasEmbeddedCredentials(value: String): Boolean {
    val afterScheme = MONGO_SCHEME_RE.replace(value, "")
    if (afterScheme == value) return false // doesn't match the scheme at all; the scheme check reports that separately
    return afterScheme.substringBefore('/').contains('@')
}

/**
 * Port validation, engine-gated and pure so [ConnectionEditorDialogValidationTest] can cover it.
 * Engines without a port must return null: a hidden field that fails validation disables OK with
 * the reason attached to a row the user cannot see.
 */
internal fun portValidationMessage(engine: EngineKind, portText: String): String? {
    if (engine !in ENGINES_WITH_HOST_PORT) return null
    val port = portText.trim().toIntOrNull()
    return if (port == null || port !in 1..65535) "Port must be a number between 1 and 65535." else null
}

private val LOG = Logger.getInstance(ConnectionEditorDialog::class.java)

private val ENGINES_WITH_HOST_PORT = setOf(EngineKind.POSTGRES, EngineKind.MYSQL, EngineKind.ORACLE)
private val FILE_ENGINES = setOf(EngineKind.SQLITE, EngineKind.DUCKDB)
/** Oracle's SSL setup (wallets) is different enough that it isn't wired through `sslMode`; see `JdbcConnectionFactory`. */
private val ENGINES_WITH_SSL_CHOICE = setOf(EngineKind.POSTGRES, EngineKind.MYSQL)

/** Add/Edit connection wizard. Password is written to PasswordSafe by the caller after [showAndGetDescriptor] returns; this dialog never touches PasswordSafe directly (except to read the existing password for "Test Connection"). */
class ConnectionEditorDialog(private val project: Project, private val existing: ConnectionDescriptor?) : DialogWrapper(project, true) {

    private var name = existing?.name ?: defaultName(existing?.engine ?: EngineKind.POSTGRES)
    private var engine = existing?.engine ?: EngineKind.POSTGRES
    private var host = existing?.host ?: "localhost"
    private var port = existing?.port ?: defaultPort(engine)
    private var database = existing?.database ?: ""
    private var user = existing?.user ?: defaultUser(engine).orEmpty()
    private var filePath = existing?.filePath ?: ""
    private var connectionString = existing?.connectionString ?: ""
    private var sslMode = existing?.sslMode ?: SslMode.TRUST
    private val passwordField = JPasswordField()

    // Offered only when adding a NEW connection, and only when DataGrip/Ultimate's
    // Database plugin is present with something importable.
    private val importCandidates: List<DataSourceImporter.ImportedDataSource> =
        if (existing == null) DataSourceImporter.listImportableDataSources(project) else emptyList()

    /** Managed .duckdb files created by [browseDuckDbFileOrImport]; any the accepted descriptor doesn't reference is an orphan and gets deleted. */
    private val importedDbPaths = mutableListOf<java.nio.file.Path>()

    private var dialogPanel: com.intellij.openapi.ui.DialogPanel? = null

    private lateinit var nameField: JTextField
    private lateinit var engineCombo: com.intellij.openapi.ui.ComboBox<EngineKind>
    private lateinit var hostField: JTextField
    private lateinit var portField: JTextField
    private lateinit var databaseField: JTextField
    private lateinit var userField: JTextField
    private lateinit var filePathField: JTextField
    private lateinit var connectionStringField: JTextField
    private lateinit var sslModeCombo: com.intellij.openapi.ui.ComboBox<SslMode>
    private lateinit var hostRow: Row
    private lateinit var portRow: Row
    private lateinit var databaseRow: Row
    private lateinit var userRow: Row
    private lateinit var filePathRow: Row
    private lateinit var connectionStringRow: Row
    private lateinit var sslModeRow: Row

    /** The last auto-filled port for the current engine; lets [onEngineChanged] tell "user typed a custom port" apart from "still showing the previous engine's default". */
    private var autoFilledPort: Int? = port

    /** Same idea as [autoFilledPort], for the default username; see [onEngineChanged]. */
    private var autoFilledUser: String? = if (existing == null) defaultUser(engine) else null

    /** Same idea again for the connection name, so the field is never blank and OK is never mysteriously unavailable. */
    private var autoFilledName: String? = if (existing == null) defaultName(engine) else null

    var enteredPassword: String? = null
        private set

    /** Bottom-left of the button row (the platform's own convention for connection dialogs), not a form row of its own. */
    private val testConnectionAction = object : javax.swing.AbstractAction("Test Connection") {
        init {
            putValue(javax.swing.Action.SHORT_DESCRIPTION, "Verifies the connection actually works before you save it - nothing is persisted.")
        }
        override fun actionPerformed(e: java.awt.event.ActionEvent) = testConnection()
    }

    init {
        title = if (existing == null) "Add AskSQL Connection" else "Edit AskSQL Connection"
        init()
        updateFieldVisibility(engine)
    }

    override fun createLeftSideActions(): Array<javax.swing.Action> = arrayOf(testConnectionAction)

    private fun defaultPort(e: EngineKind) = when (e) {
        EngineKind.POSTGRES -> 5432
        EngineKind.MYSQL -> 3306
        EngineKind.ORACLE -> 1521
        else -> null
    }

    private fun defaultName(e: EngineKind) = when (e) {
        EngineKind.POSTGRES -> "Postgres"
        EngineKind.MYSQL -> "MySQL"
        EngineKind.SQLITE -> "SQLite"
        EngineKind.DUCKDB -> "Data files"
        EngineKind.ORACLE -> "Oracle"
        EngineKind.MONGODB -> "MongoDB"
    }

    /** Each engine's common default superuser, saves retyping the same value on every new connection. Never used for MongoDB (varies too widely; many local instances run with no auth at all). */
    private fun defaultUser(e: EngineKind) = when (e) {
        EngineKind.POSTGRES -> "postgres"
        EngineKind.MYSQL -> "root"
        EngineKind.ORACLE -> "system"
        else -> null
    }

    private fun applyImportCandidate(candidate: DataSourceImporter.ImportedDataSource) {
        name = candidate.name
        engine = candidate.engine
        candidate.host?.let { host = it }
        port = candidate.port ?: defaultPort(candidate.engine)
        candidate.database?.let { database = it }
        candidate.user?.let { user = it }
        // The other fields are already-rendered Swing components bound at build time, not live bindings;
        // reset() re-reads these (now updated) backing properties back into every field on screen.
        dialogPanel?.reset()
        autoFilledPort = port
        updateFieldVisibility(engine)
    }

    private fun onEngineChanged(selected: EngineKind) {
        updateFieldVisibility(selected)
        // Re-default the port only if it still shows the PREVIOUS engine's auto-fill (blank, or
        // untouched); a port the user typed themselves is left alone even across an engine switch.
        val currentPortText = portField.text.trim()
        if (currentPortText.isEmpty() || currentPortText.toIntOrNull() == autoFilledPort) {
            val newDefault = defaultPort(selected)
            autoFilledPort = newDefault
            portField.text = newDefault?.toString().orEmpty()
        }
        if (existing == null) {
            val currentName = nameField.text.trim()
            if (currentName.isEmpty() || currentName == autoFilledName) {
                val newName = defaultName(selected)
                autoFilledName = newName
                nameField.text = newName
            }
        }
        // Same idea for the default user, only when adding (an existing saved connection's real
        // user must never be silently overwritten just because it happens to switch engine).
        if (existing == null) {
            val currentUserText = userField.text.trim()
            if (currentUserText.isEmpty() || currentUserText == autoFilledUser) {
                val newDefault = defaultUser(selected)
                autoFilledUser = newDefault
                userField.text = newDefault.orEmpty()
            }
        }
    }

    private fun updateFieldVisibility(selected: EngineKind) {
        val hasHostPort = selected in ENGINES_WITH_HOST_PORT
        val isMongo = selected == EngineKind.MONGODB
        val isFileEngine = selected in FILE_ENGINES
        hostRow.visible(hasHostPort)
        portRow.visible(hasHostPort)
        databaseRow.visible(hasHostPort || isMongo)
        userRow.visible(hasHostPort || isMongo)
        filePathRow.visible(isFileEngine)
        connectionStringRow.visible(isMongo)
        sslModeRow.visible(selected in ENGINES_WITH_SSL_CHOICE)
    }

    override fun createCenterPanel(): JComponent {
        val built = panel {
            if (importCandidates.isNotEmpty()) {
                row("Import from IDE data source:") {
                    val labels = listOf("(none)") + importCandidates.map { it.label() }
                    comboBox(labels).applyToComponent {
                        addActionListener {
                            val index = selectedIndex - 1
                            if (index >= 0) applyImportCandidate(importCandidates[index])
                        }
                    }
                }.comment("Detected from DataGrip's / this IDE's own database connections - only host/port/database/user are copied, never the password.")
            }
            row("Name:") { nameField = textField().bindText(::name).component }
            row("Engine:") {
                engineCombo = comboBox(EngineKind.entries.toList())
                    .bindItem({ engine }, { engine = it ?: engine })
                    .applyToComponent {
                        addActionListener {
                            (selectedItem as? EngineKind)?.let { onEngineChanged(it) }
                        }
                    }
                    .component
            }
            hostRow = row("Host:") { hostField = textField().bindText(::host).component }
            // Plain textField, not intTextField(1..65535): the DSL range validator also runs for engines
            // that have no port (DuckDB/SQLite/MongoDB), where the field is empty and hidden, and an
            // invisible failing field silently disables OK. doValidate checks the range where it applies.
            portRow = row("Port:") { portField = textField().bindText({ port?.toString().orEmpty() }, { port = it.toIntOrNull() }).component }
            databaseRow = row("Database:") { databaseField = textField().bindText(::database).component }
            databaseRow.comment("Also used as MongoDB's auth source database when a user/password is set below.")
            userRow = row("User:") { userField = textField().bindText(::user).component }
            // Password sits right after User (the credential pair, kept together) rather than after
            // the per-engine target fields below.
            row("Password:") { cell(passwordField) }
                .comment("Leave blank to keep the current password (Edit) or connect without one (Add).")
            filePathRow = row("File path:") {
                filePathField = textField().bindText(::filePath).component
                button("Browse...") {
                    if ((engineCombo.selectedItem as? EngineKind ?: engine) == EngineKind.DUCKDB) {
                        browseDuckDbFileOrImport()
                    } else {
                        val chosen = FileChooser.chooseFile(FileChooserDescriptor(true, false, false, false, false, false), project, null)
                        if (chosen != null) filePathField.text = chosen.path
                    }
                }
            }
            filePathRow.comment("SQLite: an existing .db file. DuckDB: pick data files (CSV, TSV, JSON, Parquet, Excel) to query as tables, an existing .duckdb file, or leave blank for a scratch database.")
            connectionStringRow = row("Connection string:") { connectionStringField = textField().bindText(::connectionString).component }
            connectionStringRow.comment("mongodb:// or mongodb+srv:// URI, without a password - the password above travels separately via the OS keychain.")
            sslModeRow = row("Encryption:") {
                sslModeCombo = comboBox(SslMode.entries.toList()).bindItem({ sslMode }, { sslMode = it ?: sslMode }).component
            }
            sslModeRow.comment("Trust (default): encrypted, certificate not verified. Verify: encrypted and certificate-checked. Disable: no encryption.")
        }
        dialogPanel = built
        return built
    }

    /** Matches [JdbcConnectionFactory]'s URL-segment check so a value it would reject fails here, at the field, not at connect time. */
    private fun urlSegmentValidation(field: JTextField, label: String): ValidationInfo? =
        if (Regex("""[/?#&@\s]""").containsMatchIn(field.text.trim())) {
            ValidationInfo("$label must not contain /, ?, #, &, @, or whitespace.", field)
        } else {
            null
        }

    /** Matches [JdbcConnectionFactory]'s file-path check: `?`/`#`/`;` carry JDBC-URL meaning even inside a path. */
    private fun filePathValidation(): ValidationInfo? =
        if (Regex("""[?#;]""").containsMatchIn(filePathField.text.trim())) {
            ValidationInfo("File path must not contain ?, #, or ;.", filePathField)
        } else {
            null
        }

    /** Runs the same per-field checks [doValidate] enforces before OK, so this dialog never accepts an obviously-incomplete connection (blank host/database, an out-of-range port, a Mongo string with no scheme or an embedded password, ...). */
    override fun doValidate(): ValidationInfo? {
        // No name check: a blank name defaults in showAndGetDescriptor, and failing validation here
        // would grey out OK with the reason easy to miss.
        return when (engineCombo.selectedItem as? EngineKind ?: engine) {
            EngineKind.POSTGRES, EngineKind.MYSQL, EngineKind.ORACLE -> {
                if (hostField.text.isBlank()) return ValidationInfo("Host is required.", hostField)
                urlSegmentValidation(hostField, "Host")?.let { return it }
                portValidationMessage(engineCombo.selectedItem as? EngineKind ?: engine, portField.text)
                    ?.let { return ValidationInfo(it, portField) }
                if (databaseField.text.isBlank()) return ValidationInfo("Database is required.", databaseField)
                urlSegmentValidation(databaseField, "Database")?.let { return it }
                if (userField.text.isBlank()) return ValidationInfo("User is required.", userField)
                null
            }
            EngineKind.SQLITE -> {
                if (filePathField.text.isBlank()) return ValidationInfo("File path is required for SQLite.", filePathField)
                filePathValidation()
            }
            EngineKind.DUCKDB -> filePathValidation() // blank means a private in-memory database, which is valid
            EngineKind.MONGODB -> {
                val value = connectionStringField.text.trim()
                if (value.isBlank()) return ValidationInfo("Connection string is required.", connectionStringField)
                if (!MONGO_SCHEME_RE.containsMatchIn(value)) {
                    return ValidationInfo("Connection string must start with mongodb:// or mongodb+srv://.", connectionStringField)
                }
                if (mongoConnectionStringHasEmbeddedCredentials(value)) {
                    return ValidationInfo(
                        "Remove the username/password from the connection string - enter them in User/Password below instead.",
                        connectionStringField,
                    )
                }
                null
            }
        }
    }

    private fun liveDescriptorForTest(): ConnectionDescriptor {
        val liveEngine = engineCombo.selectedItem as? EngineKind ?: engine
        return ConnectionDescriptor(
            id = existing?.id ?: "asksql-test-${UUID.randomUUID()}",
            name = nameField.text.ifBlank { "Test connection" },
            engine = liveEngine,
            scope = existing?.scope ?: ConnectionScope.PROJECT,
            host = hostField.text.ifBlank { null },
            port = portField.text.trim().toIntOrNull(),
            database = databaseField.text.ifBlank { null },
            user = userField.text.ifBlank { null },
            filePath = filePathField.text.ifBlank { null },
            connectionString = connectionStringField.text.ifBlank { null },
            sslMode = sslModeCombo.selectedItem as? SslMode ?: SslMode.TRUST,
        )
    }

    /**
     * DuckDB Browse: a single .duckdb is used directly; data files are loaded into a fresh
     * managed .duckdb inline (modal progress, off the EDT) and the field points at the result.
     */
    private fun browseDuckDbFileOrImport() {
        val descriptor = FileChooserDescriptor(true, false, false, false, false, true)
            .withTitle("Choose Data Files to Query, or an Existing .duckdb File")
            .withDescription("Pick one .duckdb database, or one or more data files (CSV, TSV, JSON, Parquet, XLSX, SQL) to load as tables.")
        val chosen = FileChooser.chooseFiles(descriptor, project, UploadFileToDuckDbAction.chooserStartDir(project))
        if (chosen.isEmpty()) return

        if (chosen.size == 1 && chosen[0].extension?.lowercase() == "duckdb") {
            filePathField.text = chosen[0].path
            return
        }

        val sourcePaths = chosen.map { it.path }
        val rejected = UploadFileToDuckDbAction.unsupported(sourcePaths)
        if (rejected.isNotEmpty()) {
            Messages.showErrorDialog(project, UploadFileToDuckDbAction.unsupportedMessage(rejected), "AskSQL")
            return
        }
        val dbPath = UploadFileToDuckDbAction.newManagedDbPath(sourcePaths.first())
        try {
            // Generous timeout: the first DuckDB load also lazy-downloads the driver jar.
            val tables = runBlockingWithProgress(project, "Loading ${sourcePaths.size} file(s) into DuckDB", timeoutMs = 180_000) {
                UploadFileToDuckDbAction.loadFilesInto(dbPath, sourcePaths)
            }
            importedDbPaths.add(dbPath)
            filePathField.text = dbPath.toString()
            if (nameField.text.isBlank()) {
                nameField.text = if (sourcePaths.size == 1) java.io.File(sourcePaths.first()).nameWithoutExtension else "${sourcePaths.size} data files"
            }
            Messages.showInfoMessage("Loaded ${tables.size} table(s): ${tables.joinToString(", ")}", "AskSQL")
        } catch (e: Exception) {
            runCatching { java.nio.file.Files.deleteIfExists(dbPath) }
            LOG.info("AskSQL: DuckDB import from wizard failed: ${e.message}")
            Messages.showErrorDialog("Couldn't load the files: ${ErrorPresenter.present(e).userMessage}", "AskSQL")
        }
    }

    private fun testConnection() {
        val validation = doValidate()
        if (validation != null) {
            Messages.showWarningDialog(validation.message, "AskSQL")
            return
        }
        val transient = liveDescriptorForTest()
        val typedPassword = String(passwordField.password).ifEmpty { null }
        LOG.info("AskSQL: Test Connection clicked for ${transient.engine} (id=${transient.id})")
        try {
            // The 30s timeout lives in runBlockingWithProgress (a Future.get(timeout) poll loop, not
            // a coroutine withTimeout; see its doc for why that distinction matters).
            runBlockingWithProgress(project, "Testing connection") {
                val password = typedPassword ?: existing?.let { AskSqlSecrets.getDbPassword(it) }
                if (transient.engine == EngineKind.MONGODB) {
                    MongoClientFactory.open(transient, password).close()
                } else {
                    JdbcConnectionFactory.open(transient, password).use { connection ->
                        if (!connection.isValid(5)) {
                            throw AskSqlException(AskSqlErrorCode.DB_UNREACHABLE, userMessage = "The database connected but didn't answer a health check. It may still be starting up.")
                        }
                    }
                }
            }
            LOG.info("AskSQL: Test Connection succeeded for ${transient.engine} (id=${transient.id})")
            Messages.showInfoMessage("Connected successfully.", "AskSQL")
        } catch (e: java.util.concurrent.TimeoutException) {
            LOG.info("AskSQL: Test Connection timed out for ${transient.engine} (id=${transient.id})")
            Messages.showErrorDialog("Could not connect: timed out after 30 seconds.", "AskSQL")
        } catch (e: Exception) {
            LOG.info("AskSQL: Test Connection failed for ${transient.engine} (id=${transient.id}): ${e.message}")
            Messages.showErrorDialog("Could not connect: ${ErrorPresenter.present(e).userMessage}", "AskSQL")
        }
    }

    fun showAndGetDescriptor(): ConnectionDescriptor? {
        val accepted = showAndGet()
        val keptPath = if (accepted) filePath.trim() else ""
        importedDbPaths.filter { it.toString() != keptPath }
            .forEach { runCatching { java.nio.file.Files.deleteIfExists(it) } }
        if (!accepted) return null
        enteredPassword = String(passwordField.password).ifEmpty { null }
        return ConnectionDescriptor(
            id = existing?.id ?: UUID.randomUUID().toString(),
            name = name.ifBlank { "Untitled connection" },
            engine = engine,
            scope = existing?.scope ?: ConnectionScope.PROJECT,
            host = host.ifBlank { null },
            port = port,
            database = database.ifBlank { null },
            user = user.ifBlank { null },
            filePath = filePath.ifBlank { null },
            connectionString = connectionString.ifBlank { null },
            sslMode = sslMode,
        )
    }
}
