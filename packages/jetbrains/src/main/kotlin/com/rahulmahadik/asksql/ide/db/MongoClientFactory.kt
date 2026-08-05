package com.rahulmahadik.asksql.ide.db

import com.mongodb.ConnectionString
import com.mongodb.MongoClientSettings
import com.mongodb.MongoCredential
import com.mongodb.client.MongoClient
import com.mongodb.client.MongoClients
import com.rahulmahadik.asksql.ide.errors.AskSqlErrorCode
import com.rahulmahadik.asksql.ide.errors.AskSqlException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.bson.Document
import java.util.concurrent.TimeUnit

/** Opens a [MongoClient] for a [ConnectionDescriptor]. Unlike [JdbcConnectionFactory], no read-only enforcement is applied here; see [com.rahulmahadik.asksql.ide.guard.MongoGuard]'s class doc. */
object MongoClientFactory {

    suspend fun open(descriptor: ConnectionDescriptor, password: String?): MongoClient =
        withContext(Dispatchers.IO) {
            val connectionString = descriptor.connectionString?.takeIf { it.isNotBlank() } ?: throw AskSqlException(
                AskSqlErrorCode.CONFIG_ERROR,
                userMessage = "This MongoDB connection has no connection string configured.",
            )

            val settings = MongoClientSettings.builder().applyConnectionString(ConnectionString(connectionString)).apply {
                applicationName("AskSQL") // visible in db.currentOp()/serverStatus()
                applyToConnectionPoolSettings { it.maxSize(5).maxConnectionIdleTime(60, TimeUnit.SECONDS) }
                // Shorter than the driver's own 30s/10s defaults, matching the other engines' ~10s connect timeouts.
                applyToClusterSettings { it.serverSelectionTimeout(10, TimeUnit.SECONDS) }
                applyToSocketSettings { it.connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS) }
                if (!descriptor.user.isNullOrBlank() && !password.isNullOrEmpty()) {
                    val authSource = descriptor.database?.takeIf { it.isNotBlank() } ?: "admin"
                    credential(MongoCredential.createCredential(descriptor.user, authSource, password.toCharArray()))
                }
            }.build()

            val client = try {
                MongoClients.create(settings)
            } catch (e: Exception) {
                throw AskSqlException(AskSqlErrorCode.DB_UNREACHABLE, detail = e.message, cause = e)
            }
            try {
                // MongoClients.create() never blocks or validates; the ping forces one real round-trip.
                client.getDatabase(descriptor.database?.takeIf { it.isNotBlank() } ?: "admin")
                    .runCommand(Document("ping", 1))
                client
            } catch (e: Exception) {
                client.close()
                val msg = e.message.orEmpty()
                val isAtlas = Regex("mongodb\\+srv|mongodb\\.net", RegexOption.IGNORE_CASE).containsMatchIn(connectionString)
                throw AskSqlException(AskSqlErrorCode.DB_UNREACHABLE, userMessage = connectFailureMessage(msg, isAtlas), detail = msg, cause = e)
            }
        }

    /** Actionable message for a failed Mongo connect: bad creds vs an Atlas IP allow-list vs a plain unreachable host. */
    internal fun connectFailureMessage(errorMessage: String, isAtlas: Boolean): String = when {
        Regex("auth|not authorized|bad auth", RegexOption.IGNORE_CASE).containsMatchIn(errorMessage) ->
            "MongoDB rejected the credentials. Check the username/password - and remove any placeholder angle brackets (< >) around the password."
        isAtlas ->
            "Could not reach the MongoDB Atlas cluster. Add your current IP under Atlas -> Network Access (or 0.0.0.0/0 to test), and confirm the cluster is running."
        else -> "Could not reach the MongoDB server. Check the host/port and that it is running."
    }
}
