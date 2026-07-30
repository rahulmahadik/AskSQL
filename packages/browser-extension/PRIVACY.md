# AskSQL Browser Extension — Privacy Policy

Last updated: 2026-07-28.

## What this extension does

AskSQL turns plain-language questions into SQL, either against data files you
load into a connection (analyzed entirely in your browser) or against a
database reachable through a sidecar server you run yourself. It has one
purpose: helping you query data you already have access to.

## What data it collects

**None, by AskSQL.** This extension has no analytics, no telemetry, no error
reporting service, and no server of its own. Nothing you do in it is sent
anywhere except:

- **The AI provider you configure** (Ollama, Groq, OpenAI, Anthropic, Google,
  Azure, NVIDIA, or an OpenAI-compatible endpoint you specify) receives your
  question and your database **schema** (table/column names and types) so it
  can write SQL. **It never receives your row data or query results** — only
  schema and the question you typed.
- **The sidecar server you configure**, if you use one, receives your
  question and, when you run a query, the query and its results — because
  that's the server you told the extension to talk to. AskSQL doesn't operate
  or have access to this server; you run it.

## Database credentials

When you add a database connection, the host, port, database name, user name and
password you enter are sent **once, directly to the AskSQL server URL you
configured** (your own machine or infrastructure), which opens the database and
keeps those credentials. This browser stores only that server's URL and the
connection id it returns - **never the database password**. Nothing is sent to
any third party.

## What's stored, and where

Everything below lives only in this browser's local extension storage
(`chrome.storage.local`/`chrome.storage.session`) — never on any AskSQL server,
because none exists.

| Data | Where | Retention |
|---|---|---|
| AI provider, model, base URL | `chrome.storage.local` | Until you change or reset it |
| AI provider API key, if you enter one | `chrome.storage.local`, **unencrypted** | Until you change or reset it |
| Sidecar server name, URL, auth header | `chrome.storage.local`, **unencrypted** | Until you remove the connection or reset |
| Engine settings (row cap, approval mode, etc.) | `chrome.storage.local` | Until changed |
| Data file connection name and table names | `chrome.storage.local` | Until you remove that connection or reset |
| The file data itself | An OPFS-backed database in this browser profile, one per data file connection | Until you **Remove** that connection, or **Reset everything** |
| A page-selection question (ask-about-selection) | `chrome.storage.session` | Consumed immediately, or discarded after 30 seconds unconsumed; cleared on browser exit regardless |

**There is no OS-level keychain available to a browser extension.** API keys
and sidecar auth headers are stored as plain text in the browser profile's own
storage. Anyone with access to that profile (or a malicious extension granted
excessive access) could read them. Only enter credentials you're comfortable
storing this way.

**Query results and row data are never written to any of the above.** Chat
history, including results, exists only in the side panel's in-memory state
and disappears when the panel closes. (The data files behind a connection persist as described
**Save** on, which stores the question and SQL — never row data — as a saved
query).

## Requests to your AI provider are sent without an Origin header

Chrome attaches an `Origin: chrome-extension://…` header to the requests this
extension makes to your AI provider. Local AI servers (Ollama, LM Studio, and
similar) reject a browser-extension origin by default, which would otherwise
make the extension unusable with a local model unless you reconfigured that
server yourself.

AskSQL therefore removes the `Origin` header from requests to **the one AI
provider endpoint you have configured** — nothing else. It is never applied to
a sidecar server, to any website you visit, or to any other address.
It removes a header; it never adds, forges, or forwards anything. The rule only
applies to an origin after you have granted AskSQL permission to reach it, and
it is removed when you use **Reset everything**.

## Your controls

- **Reset everything** (Settings page): clears every setting, connection, saved
  query, and every data file connection's stored data, and revokes every
  site-access permission the extension was granted.
- **Remove** on a data file connection (Settings page): deletes that
  connection's database outright, without touching your other settings.
- Standard browser extension management (`chrome://extensions` /
  `edge://extensions`) lets you remove the extension entirely, which removes
  all of its storage.

## Permissions

- `sidePanel`, `storage`, `contextMenus` — the extension's own UI and its
  local settings storage; the context menu is for "Ask AskSQL about
  selection."
- Optional host permissions (`http://*/*`, `https://*/*`) — requested
  per-site, only when you configure an AI provider or sidecar at that
  address. Never granted upfront for every site; you can revoke any of them
  at any time via Reset or the browser's own extension permissions UI.
  Granting this is what lets AskSQL reach a provider or server at all.
- `declarativeNetRequestWithHostAccess` — used for one thing only: removing
  the `Origin` header from requests to your configured AI provider, as
  described above. It cannot read request or response bodies, and it never
  blocks or redirects anything.

## Changes to this policy

If what this extension collects or stores changes, this file changes with it.
