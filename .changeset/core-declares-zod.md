---
'@asksql/core': patch
---

Declare `zod`, so the package imports under a package manager that does not auto-install peers.

`ai` requires `zod` as a peer dependency and nothing in AskSQL passed that on. npm 7+ and pnpm
install peers automatically, which hid it; Yarn Classic, Yarn PnP and any `--legacy-peer-deps`
install left `import '@asksql/core'` throwing `Cannot find package 'zod'` before a single line of
AskSQL ran. The declared range mirrors what `ai` accepts, so a project already on zod 3 keeps one
copy rather than gaining a second.
