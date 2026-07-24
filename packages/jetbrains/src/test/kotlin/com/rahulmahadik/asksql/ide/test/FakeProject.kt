package com.rahulmahadik.asksql.ide.test

import com.intellij.openapi.project.Project
import java.lang.reflect.InvocationHandler
import java.lang.reflect.Proxy

/**
 * Stands in for [Project] in unit tests that construct a `@Service(Level.PROJECT)`
 * class but never invoke a method on it; a plain JUnit test can't build the
 * real platform object, and none of the classes using this fake need one.
 */
fun fakeProject(): Project {
    val handler = InvocationHandler { proxy, method, args ->
        when (method.name) {
            "equals" -> proxy === args?.get(0)
            "hashCode" -> System.identityHashCode(proxy)
            "toString" -> "FakeProject"
            else -> null
        }
    }
    return Proxy.newProxyInstance(Project::class.java.classLoader, arrayOf(Project::class.java), handler) as Project
}
