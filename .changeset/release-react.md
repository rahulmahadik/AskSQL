---
"@asksql/react": patch
---

Show the connected database name in the connection picker. Inject styles once per target root — and into a shadow root when one is passed — instead of a single process-wide flag, so a second document or shadow tree is still styled. Record a real `savedAt` timestamp on saved queries.
