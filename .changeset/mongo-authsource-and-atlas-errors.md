---
"@asksql/mongodb": patch
---

Default the separate user/password `authSource` to `admin` (fixes authentication for root/Atlas users, who don't live in the query database; overridable via a new `authSource` option), and give clearer connection errors - an Atlas IP allow-list hint on a TLS/timeout failure, and a note about the `<password>` placeholder brackets on an auth failure.
