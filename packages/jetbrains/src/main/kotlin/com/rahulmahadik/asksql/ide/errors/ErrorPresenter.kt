package com.rahulmahadik.asksql.ide.errors

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project

/**
 * The single place deciding how an error reaches the user and the log: only [AskSqlException.userMessage] is shown,
 * [AskSqlException.detail] goes to idea.log. Expected failures log at `warn`; `error` would trigger the IDE's "Fatal Error" dialog.
 */
object ErrorPresenter {

    private val log = logger<ErrorPresenter>()
    private const val NOTIFICATION_GROUP_ID = "AskSQL"

    /** Normalizes any [Throwable] to an [AskSqlException], logging appropriately as a side effect. */
    fun present(throwable: Throwable): AskSqlException {
        if (throwable is AskSqlException) {
            log.warn("AskSQL: ${throwable.code} - ${throwable.detail ?: throwable.userMessage}", throwable.cause)
            return throwable
        }
        // A user-initiated cancel isn't a bug and isn't worth a warn-level log entry.
        if (throwable is kotlinx.coroutines.CancellationException) {
            return AskSqlException(AskSqlErrorCode.CANCELLED, detail = throwable.message, cause = throwable, retryable = false)
        }
        // An unclassified throwable means a call site failed to wrap its failure as AskSqlException.
        log.error("AskSQL: unexpected exception", throwable)
        return AskSqlException(AskSqlErrorCode.UNKNOWN, cause = throwable)
    }

    fun notify(project: Project?, throwable: Throwable, type: NotificationType = NotificationType.WARNING) {
        val exception = present(throwable)
        NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP_ID)
            .createNotification(exception.userMessage, type)
            .notify(project)
    }

    fun notifyInfo(project: Project?, message: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP_ID)
            .createNotification(message, NotificationType.INFORMATION)
            .notify(project)
    }
}
