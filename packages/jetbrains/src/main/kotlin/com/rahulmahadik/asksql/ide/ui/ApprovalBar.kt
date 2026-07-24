package com.rahulmahadik.asksql.ide.ui

import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import java.awt.FlowLayout
import javax.swing.JButton

/**
 * Inline (never modal) Run/Cancel affordance. Only shown when `requireApproval` is on;
 * the default is OFF, matching the VS Code extension: auto-run with the SQL always displayed first.
 */
class ApprovalBar(onRun: () -> Unit, onCancel: () -> Unit) {

    val component = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.LEFT, 4, 2))

    init {
        component.add(JBLabel("Review the query above, then:")) // "query", not "SQL": the same bar approves Mongo pipelines
        val runButton = JButton("Run")
        val cancelButton = JButton("Cancel")
        // Without disabling both on the first click, this bar stays live below the (now-appended)
        // result: a second click could re-run the query, or Cancel after Run already fired could
        // show a stray "Cancelled." under a result that already ran.
        runButton.addActionListener {
            runButton.isEnabled = false
            cancelButton.isEnabled = false
            onRun()
        }
        component.add(runButton)
        cancelButton.addActionListener {
            runButton.isEnabled = false
            cancelButton.isEnabled = false
            onCancel()
        }
        component.add(cancelButton)
    }
}
