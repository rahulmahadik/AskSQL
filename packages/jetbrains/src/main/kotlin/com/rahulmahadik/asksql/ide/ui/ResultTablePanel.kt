package com.rahulmahadik.asksql.ide.ui

import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.TableSpeedSearch
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.table.JBTable
import com.rahulmahadik.asksql.ide.errors.ErrorPresenter
import com.rahulmahadik.asksql.ide.model.AskSqlResultSet
import com.rahulmahadik.asksql.ide.model.CellValue
import com.rahulmahadik.asksql.ide.util.runBlockingWithProgress
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.datatransfer.StringSelection
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import javax.swing.JPanel
import javax.swing.table.AbstractTableModel

/**
 * Renders one [AskSqlResultSet] as a [JBTable]. Cells display their fidelity-safe string form
 * (see [JdbcExecutor] for why BIGINT/DECIMAL never touch a JVM `Double`); null and empty string render distinctly.
 */
class ResultTablePanel(private val project: Project, private val resultSet: AskSqlResultSet) {

    companion object {
        /** Column sizing scans this many rows for the widest value. */
        private const val SIZING_SAMPLE_ROWS = 2_000
        private const val TOOLTIP_MAX_CHARS = 2_000
    }

    val component: JPanel = JPanel(BorderLayout())

    init {
        val model = object : AbstractTableModel() {
            override fun getRowCount() = resultSet.rows.size
            override fun getColumnCount() = resultSet.columns.size
            override fun getColumnName(column: Int) = resultSet.columns[column].name
            override fun getValueAt(rowIndex: Int, columnIndex: Int): Any = displayString(resultSet.rows[rowIndex][columnIndex])
        }
        val table = object : JBTable(model) {
            /** Wide results overflow into the scroll pane's horizontal scrollbar; a narrower result stretches to fill the viewport. */
            override fun getScrollableTracksViewportWidth(): Boolean {
                val viewportWidth = parent?.width ?: return false
                return preferredSize.width < viewportWidth
            }
        }
        TableSpeedSearch.installOn(table)
        table.emptyText.text = "No rows returned"
        // Columns hug their content instead of stretching equally across the panel; the scroll pane takes any horizontal overflow.
        table.autoResizeMode = javax.swing.JTable.AUTO_RESIZE_OFF
        table.setDefaultRenderer(Any::class.java, CellRenderer())
        styleHeaderAndGrid(table)
        sizeColumnsToContent(table)
        if (resultSet.rows.isEmpty()) {
            // A JBTable's emptyText overlay is clipped at the small height an empty table asks for, so an empty result gets its own label.
            component.add(
                JBLabel("No rows returned").apply {
                    horizontalAlignment = javax.swing.SwingConstants.CENTER
                    foreground = com.intellij.ui.JBColor.GRAY
                    border = JBUI.Borders.empty(12, 8)
                },
                BorderLayout.CENTER,
            )
        } else {
            table.visibleRowCount = resultSet.rows.size.coerceIn(3, 15)
            val scroll = JBScrollPane(table)
            // Both scrollbar policies are set explicitly.
            scroll.horizontalScrollBarPolicy = javax.swing.ScrollPaneConstants.HORIZONTAL_SCROLLBAR_AS_NEEDED
            scroll.verticalScrollBarPolicy = javax.swing.ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED
            component.add(scroll, BorderLayout.CENTER)
        }

        if (resultSet.truncated) {
            val banner = javax.swing.JLabel("Showing the first ${resultSet.rows.size} rows - raise the row cap in Settings to see more. Export CSV writes the rows shown here.")
            banner.border = javax.swing.BorderFactory.createEmptyBorder(2, 8, 2, 8)
            component.add(banner, BorderLayout.SOUTH)
        }
    }

    /** The default header renderer draws like an ordinary row; bold text plus a separator line makes it read as a header. */
    private fun styleHeaderAndGrid(table: JBTable) {
        val header = table.tableHeader
        header.reorderingAllowed = false
        val base = header.defaultRenderer
        header.defaultRenderer = javax.swing.table.TableCellRenderer { t, value, selected, focused, row, col ->
            val c = base.getTableCellRendererComponent(t, value, selected, focused, row, col)
            (c as? javax.swing.JComponent)?.apply {
                font = font.deriveFont(java.awt.Font.BOLD)
                border = com.intellij.util.ui.JBUI.Borders.compound(
                    com.intellij.util.ui.JBUI.Borders.customLine(com.intellij.ui.JBColor.border(), 0, 0, 1, 1),
                    com.intellij.util.ui.JBUI.Borders.empty(3, 6),
                )
            }
            c
        }
        table.setShowGrid(true)
        table.gridColor = com.intellij.ui.JBColor.border()
    }

    /** Sizes each column to the header width or the widest of the first [SIZING_SAMPLE_ROWS] cells, clamped. */
    private fun sizeColumnsToContent(table: JBTable) {
        val metrics = table.getFontMetrics(table.font)
        val headerMetrics = table.tableHeader.getFontMetrics(table.tableHeader.font)
        val pad = com.intellij.util.ui.JBUI.scale(14)
        val minWidth = com.intellij.util.ui.JBUI.scale(48)
        val maxWidth = com.intellij.util.ui.JBUI.scale(320)
        val sampled = minOf(resultSet.rows.size, SIZING_SAMPLE_ROWS)
        for (col in resultSet.columns.indices) {
            var width = headerMetrics.stringWidth(resultSet.columns[col].name)
            var longest = 0
            for (row in 0 until sampled) {
                val raw = displayString(resultSet.rows[row][col])
                // Character count is a cheap proxy, so only a new longest value pays for text layout and line flattening on the EDT.
                if (raw.length <= longest) continue
                longest = raw.length
                width = maxOf(width, metrics.stringWidth(flattenLines(raw)))
            }
            table.columnModel.getColumn(col).preferredWidth = (width + pad).coerceIn(minWidth, maxWidth)
        }
    }

    /**
     * Cells clamp at [sizeColumnsToContent]'s max width, so the full value lives in the tooltip.
     * Multi-line values collapse to one line: a JLabel renders an embedded newline as a squashed glyph.
     */
    private inner class CellRenderer : javax.swing.table.DefaultTableCellRenderer() {
        override fun getTableCellRendererComponent(
            table: javax.swing.JTable,
            value: Any?,
            isSelected: Boolean,
            hasFocus: Boolean,
            row: Int,
            column: Int,
        ): java.awt.Component {
            val text = value?.toString().orEmpty()
            val c = super.getTableCellRendererComponent(table, flattenLines(text), isSelected, hasFocus, row, column)
            (c as? javax.swing.JComponent)?.toolTipText = tooltipFor(text)
            return c
        }
    }

    private fun flattenLines(text: String): String =
        if (text.contains('\n') || text.contains('\r')) text.replace(Regex("\\s*[\\r\\n]+\\s*"), " ⏎ ") else text

    /** HTML so a multi-line value keeps its line breaks in the tooltip; capped so a large blob can't paint a full-screen popup. */
    private fun tooltipFor(text: String): String? {
        if (text.isEmpty()) return null
        val capped = if (text.length > TOOLTIP_MAX_CHARS) text.take(TOOLTIP_MAX_CHARS) + "…" else text
        val escaped = capped
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\n", "<br>")
        return "<html>$escaped</html>"
    }


    /** Builds the tab-separated text off the EDT under a cancellable progress; it is O(rows × columns) up to the connection's `maxRows`. */
    fun copyToClipboard() {
        try {
            val text = runBlockingWithProgress(project, "Preparing copy") {
                val header = resultSet.columns.joinToString("\t") { tsvEscape(it.name) }
                val body = resultSet.rows.joinToString("\n") { row -> row.joinToString("\t") { tsvEscape(displayString(it)) } }
                "$header\n$body"
            }
            com.intellij.openapi.ide.CopyPasteManager.getInstance().setContents(StringSelection(text))
        } catch (e: Exception) {
            Messages.showErrorDialog("Could not copy the result: ${ErrorPresenter.present(e).userMessage}", "AskSQL")
        }
    }

    /** Builds the CSV text off the EDT, like [copyToClipboard]. */
    fun openInEditor() {
        try {
            val text = runBlockingWithProgress(project, "Preparing editor view") {
                val header = resultSet.columns.joinToString(",") { csvEscape(it.name) }
                val body = resultSet.rows.joinToString("\n") { row -> row.joinToString(",") { csvEscape(displayString(it)) } }
                "$header\n$body"
            }
            val file = LightVirtualFile("asksql-result.csv", text)
            FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, file), true)
        } catch (e: Exception) {
            Messages.showErrorDialog("Could not open the result in an editor: ${ErrorPresenter.present(e).userMessage}", "AskSQL")
        }
    }

    /** Writes the currently displayed rows - already capped at the connection's `maxRows` - to a CSV file the user picks. */
    fun exportCsv() {
        val descriptor = FileSaverDescriptor("Export AskSQL Result", "Choose where to save the CSV file", "csv")
        val wrapper = com.intellij.openapi.fileChooser.FileChooserFactory.getInstance()
            .createSaveFileDialog(descriptor, project)
            .save("asksql-result.csv") ?: return
        val file = wrapper.file
        try {
            runBlockingWithProgress(project, "Exporting CSV") {
                OutputStreamWriter(file.outputStream(), StandardCharsets.UTF_8).use { writer ->
                    writer.write(resultSet.columns.joinToString(",") { csvEscape(it.name) })
                    writer.write("\n")
                    for (row in resultSet.rows) {
                        writer.write(row.joinToString(",") { csvEscape(displayString(it)) })
                        writer.write("\n")
                    }
                }
            }
            VfsUtil.markDirtyAndRefresh(true, false, false, file)
            Messages.showInfoMessage("Exported to ${file.path}.", "AskSQL")
        } catch (e: Exception) {
            Messages.showErrorDialog("Could not export the CSV file: ${ErrorPresenter.present(e).userMessage}", "AskSQL")
        }
    }

}

/** The fidelity-safe string form of a cell; null and empty string render distinctly. */
internal fun displayString(value: CellValue): String = when (value) {
    is CellValue.Null -> "∅ NULL"
    is CellValue.Text -> value.value
    is CellValue.Number -> value.value.toString()
    is CellValue.Boolean -> value.value.toString()
    is CellValue.ExactNumeric -> value.value
    is CellValue.Binary -> "⟨${value.preview.bytes} bytes: ${value.preview.hexPreview}${if (value.preview.bytes > 32) "…" else ""}⟩"
}

/** Leading characters Excel and Sheets evaluate as a formula rather than reading as text. */
private val FORMULA_LEAD_RE = Regex("""^[=+\-@\t\r]""")

/** RFC 4180 quoting for one CSV field; a formula lead that is not a number gets a leading apostrophe. */
/** A pasted cell lands in a spreadsheet like an exported one, so it gets the same formula guard. */
internal fun tsvEscape(value: String): String {
    val field = if (FORMULA_LEAD_RE.containsMatchIn(value) && value.toDoubleOrNull()?.isFinite() != true) "'$value" else value
    return field.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')
}

internal fun csvEscape(value: String): String {
    val field = if (FORMULA_LEAD_RE.containsMatchIn(value) && value.toDoubleOrNull()?.isFinite() != true) "'$value" else value
    return if (field.contains(',') || field.contains('"') || field.contains('\n') || field.contains('\r')) {
        "\"${field.replace("\"", "\"\"")}\""
    } else {
        field
    }
}
