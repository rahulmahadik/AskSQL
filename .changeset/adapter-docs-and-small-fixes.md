---
'@asksql/postgres': patch
'@asksql/sqlite': patch
'@asksql/duckdb': patch
'@asksql/mongodb': patch
'@asksql/oracle': patch
'@asksql/react': patch
'@asksql/widget': patch
'@asksql/mcp': patch
---

Tighten the connector internals and the documentation that ships with them.

No API changed. The comments carried through each package were rewritten to state what the code
does rather than narrate how it came to be written, which is what shows up in editor tooltips and
generated docs. Alongside that, the BSON value handling shared by MongoDB introspection and result
shaping is documented against the types it actually produces, and the row-shaping paths agree with
the guard about which trailing limit is the truncation signal, so a result that exactly fills the
row cap is no longer probed a second time.
