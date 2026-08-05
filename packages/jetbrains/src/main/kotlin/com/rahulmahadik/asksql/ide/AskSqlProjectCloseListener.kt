package com.rahulmahadik.asksql.ide

import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectCloseListener
import com.rahulmahadik.asksql.ide.db.ConnectionRegistry
import com.rahulmahadik.asksql.ide.db.MongoClientRegistry

/** Registered in `plugin.xml` under `applicationListeners`; `projectClosing` fires before the project's services are torn down. */
class AskSqlProjectCloseListener : ProjectCloseListener {
    override fun projectClosing(project: Project) {
        project.getService(ConnectionRegistry::class.java).closeAll()
        project.getService(MongoClientRegistry::class.java).closeAll()
    }
}
