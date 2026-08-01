---
'@asksql/widget': patch
---

Rebuilt against the current `@asksql/react`, so the widget's truncation notice no longer says an
export returns the full result.

The widget ships a prebuilt bundle with `@asksql/react` inlined, so a semver range cannot deliver
a change in that package: the code is baked in at build time. Whenever `@asksql/react` changes,
`@asksql/widget` needs a release of its own to carry it.
