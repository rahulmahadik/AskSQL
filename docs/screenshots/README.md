# AskSQL - real screenshots

Captured from the **actual running app** in headless Chrome:
Chrome -> built Vite bundle -> Express sidecar -> live PostgreSQL -> Groq
(`llama-3.3-70b`).

### Full-page chat - ask, review SQL, results (light)
Connection picker (two DBs), the generated SQL shown before it runs, the plain-language
explanation, and the result table. Note the BIGINT value `1000000249999` preserved exactly.

![Results table, light](01-empty-light.png)
![Results table, light](02-results-table-light.png)

### One-click chart from the same result
The result is category + numeric, so a **Chart** toggle appears; the bar chart is inline SVG,
theme-aware (y-axis auto-formats to `1.0T`).

![Bar chart, light](03-chart-light.png)

### Dark mode (automatic via `prefers-color-scheme`)
![Results, dark](04-results-dark.png)
![Chart, dark](04b-chart-dark.png)

### Floating chat-head bubble - placed clear of host UI
The host page has a bottom-right "scroll to top" button, so the bubble is mounted
**bottom-left** (`position: 'bottom-left'`) - no overlap. Closed, then open:

![Bubble closed](05-bubble-closed.png)
![Bubble open](06-bubble-open.png)

### Suggested fix on a failed query
When a run fails (here an edited query references a column that does not exist), the error is
plain-language and the app offers a **corrected query** with an "Apply suggested fix" button -
it never auto-runs.

![Suggested fix](08-suggested-fix-light.png)

### Clean, retryable errors
An unreachable connection surfaces a plain "Can't reach the database right now." with a **Retry**
button - no stack trace, no frozen UI.

![Retry on error](09-retry-light.png)

### Zero-backend, in the browser (the product wedge)
Upload a CSV, ask a question - DuckDB-WASM parses and queries it in a Web Worker, the
engine + guard run client-side, and **nothing leaves the tab**. The result
(`NA = 2480.25`, computed in-browser) proves the whole loop with no server.

![Browser DuckDB-WASM](07-browser-duckdb.png)
