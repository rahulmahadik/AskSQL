package com.rahulmahadik.asksql.ide.db

import com.intellij.openapi.Disposable
import org.junit.Assert.assertTrue
import org.junit.Test

/** Project-scoped registries close their connections through dispose; losing that leaks a live connection per project. */
class RegistryDisposalTest {

    private val registries = listOf(ConnectionRegistry::class.java, MongoClientRegistry::class.java)

    @Test fun `both registries are disposable`() {
        for (cls in registries) {
            assertTrue("${cls.simpleName} no longer implements Disposable", Disposable::class.java.isAssignableFrom(cls))
        }
    }

    @Test fun `dispose is declared on each registry, not merely inherited`() {
        for (cls in registries) {
            val declared = cls.declaredMethods.any { it.name == "dispose" && it.parameterCount == 0 }
            assertTrue("${cls.simpleName} declares no dispose()", declared)
        }
    }

    @Test fun `each registry still exposes the teardown dispose delegates to`() {
        for (cls in registries) {
            val closeAll = cls.declaredMethods.any { it.name == "closeAll" && it.parameterCount == 0 }
            assertTrue("${cls.simpleName} declares no closeAll()", closeAll)
        }
    }
}
