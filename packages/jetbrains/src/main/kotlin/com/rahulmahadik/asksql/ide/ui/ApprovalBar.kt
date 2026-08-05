package com.rahulmahadik.asksql.ide.ui

import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import java.awt.FlowLayout
import javax.swing.JButton

/** Inline (never modal) Run/Cancel affordance, shown only when `requireApproval` is on. */
class ApprovalBar(onRun: () -> Unit, onCancel: () -> Unit) {

    val component = JBPanel<JBPanel<*>>(FlowLayout(FlowLayout.LEFT, 4, 2))

    init {
        component.add(JBLabel("Review the query above, then:")) // "query", not "SQL": the same bar approves Mongo pipelines
        val runButton = JButton("Run")
        val cancelButton = JButton("Cancel")
        // Both buttons disable on the first click: the bar stays live in the transcript after the query runs.
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
