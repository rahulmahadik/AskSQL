package com.rahulmahadik.asksql.ide.ui

import com.rahulmahadik.asksql.ide.db.ConnectionDescriptor
import com.rahulmahadik.asksql.ide.db.ConnectionScope
import com.rahulmahadik.asksql.ide.model.EngineKind
import javax.swing.JComboBox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A settings change calls `ChatPanel.refresh()`, which repopulates the connection picker. Swing
 * selects the first item as soon as one is added to an empty model, so a naive rebuild moves the
 * user to a different database while the previous one's transcript stays on screen and in the
 * prompt context. See [selectionAfterRefresh] and `ChatPanel.rebuildingCombo`.
 */
class ChatPanelSelectionTest {

    private fun descriptor(id: String) =
        ConnectionDescriptor(id = id, name = id, engine = EngineKind.POSTGRES, scope = ConnectionScope.PROJECT)

    private val a = descriptor("a")
    private val b = descriptor("b")

    @Test fun `keeps the connection that was selected before the rebuild`() {
        assertEquals(b, selectionAfterRefresh(listOf(a, b), "b"))
    }

    @Test fun `falls back to the first entry when the selected connection was deleted`() {
        assertEquals(a, selectionAfterRefresh(listOf(a, b), "gone"))
    }

    @Test fun `falls back to the first entry when nothing was selected yet`() {
        assertEquals(a, selectionAfterRefresh(listOf(a, b), null))
    }

    @Test fun `has nothing to select when every connection is gone`() {
        assertNull(selectionAfterRefresh(emptyList(), "b"))
    }

    /**
     * The reason the rebuild is guarded rather than just re-selecting afterwards: clearing the combo
     * fires a selection event carrying null, which would erase the very id the restore depends on.
     */
    @Test fun `clearing the combo reports a null selection before the restore can read it`() {
        val combo = JComboBox<ConnectionDescriptor>()
        val seen = mutableListOf<String?>()
        combo.addItem(a)
        combo.addItem(b)
        combo.selectedItem = b
        combo.addActionListener { seen += (combo.selectedItem as? ConnectionDescriptor)?.id }

        combo.removeAllItems()
        combo.addItem(a)
        combo.addItem(b)

        // Unguarded, the last id this listener records is "a" - the user was moved off "b".
        assertEquals(listOf(null, "a"), seen)
        assertEquals(a, combo.selectedItem)

        // Guarded, the id survives the rebuild and drives the restore back to "b".
        combo.selectedItem = selectionAfterRefresh(listOf(a, b), "b")
        assertEquals(b, combo.selectedItem)
    }
}
