---
"@asksql/server": patch
---

Scope `/history` to the authenticated user, so one user can no longer read another's history on a shared connection. Reject non-`application/json` POST bodies with 415 (CSRF hardening). Scope `/health` to the caller's allowed connections. Preserve a real error (for example body-too-large) instead of mislabeling every request-body failure as invalid JSON.
