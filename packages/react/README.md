# @asksql/react

React components and hooks for [AskSQL](https://github.com/rahulmahadik/AskSQL):

- `<AskSqlChat />`: full-page chat with SQL review, results table, charts.
- `<AskSqlBubble />`: floating chat head you can drop into any app.
- `useAskSql`: headless hook exposing the whole ask / approve / run state
  machine, for building your own UI.
- Building blocks: `<ResultTable />`, `<SqlBlock />`, `<SchemaBrowser />`,
  `<ResultChart />`.
- `useSavedQueries` / `SavedQueryStore`: pin and reuse questions
  (localStorage-backed, SSR-safe).

Light and dark themes, CSS-variable theming, CSP nonce support.

![AskSQL React chat: a plain-language question turned into SQL, with the results and a chart below it](https://github.com/rahulmahadik/AskSQL/raw/HEAD/docs/screenshots/02-results-table-light.png)

Turn on `answerSchemaQuestions` and questions that aren't a data query - "how are the tables related?", "summarize this database", even "how would I add an index?" - get a grounded, read-only explanation from the schema instead of an error. A question with nothing to do with data is declined in one line. No query is run, and names it can't find are flagged:

![AskSQL React chat answering "How are the tables related?" with a plain-language explanation of the foreign-key relationships - no query, no results table](https://github.com/rahulmahadik/AskSQL/raw/HEAD/docs/screenshots/10-schema-answer-light.png)

```bash
npm i @asksql/core @asksql/react
```

## Drop-in chat

```tsx
import { AskSqlChat, HttpTransport } from '@asksql/react';

const transport = new HttpTransport({ baseUrl: '/asksql' });

export function Page() {
  return <AskSqlChat transport={transport} />;
}
```

`HttpTransport` talks to an [`@asksql/server`](https://www.npmjs.com/package/@asksql/server) sidecar at
`baseUrl`; credentials never reach the browser. Pass `headers` for an auth token.

## Headless

`useAskSql` models the conversation as `turns`; each turn carries its own `sql`, `result`, `error`, etc.

```tsx
import { useAskSql, HttpTransport } from '@asksql/react';

const transport = new HttpTransport({ baseUrl: '/asksql' });

function MyUi() {
  const { turns, busy, ask, run, editSql, cancel } = useAskSql({ transport });

  return (
    <>
      <button disabled={busy} onClick={() => ask('How many orders shipped today?')}>Ask</button>
      {turns.map((t) => (
        <div key={t.id}>
          <div>{t.question}</div>
          {t.sql && <pre>{t.sql}</pre>}
          {t.result && <span>{t.result.rowCount} rows</span>}
          {t.error && <p role="alert">{t.error.userMessage}</p>}
        </div>
      ))}
    </>
  );
}
```

## Charts

The table is always the default view. A **Chart** toggle appears next to it only when the result
can say something a table cannot: at most 50 rows, at least 2 columns, and at least one numeric
column besides the label column. A date or timestamp label draws a line chart, anything else a
bar chart, and at most 4 series are plotted. Nothing switches to a chart on its own.
`<ResultChart>` and the `isChartable(result)` predicate are exported if you want the same rule in
your own layout.

## Reaching the server

When the sidecar is unreachable (wrong `baseUrl`, server down, or a **CORS** rejection), the transport
surfaces a typed error with `code: 'NETWORK_ERROR'` and an actionable `userMessage`, distinct from an
HTTP error the server returned. The components render it inline; with the hook, read it from the turn's
`error.userMessage`. If you see `NETWORK_ERROR` in the browser, check that `baseUrl` is correct and that
the server allows the page's origin (CORS).

## No backend at all

`LocalTransport` wraps a `@asksql/core` engine running in the same tab (for example
DuckDB-WASM over uploaded files), so the whole ask -> guard -> run loop happens
in-browser - same `<AskSqlChat>`, no server.

`<AskSqlChat>` also accepts `initialQuestion` (asked automatically whenever it changes
to a new non-empty value - e.g. an "ask about selection" hand-off, with
`onInitialQuestionConsumed` to clear your state) and `sqlDisplayPlacement`
(`'before' | 'after'`) to show results first with the SQL below.

## Customizing the UI

The UI is override-friendly at four levels, lightest to fully custom:

**Theme with CSS variables** - restyle without touching components. Override any of
`--aq-accent`, `--aq-bg`, `--aq-surface`, `--aq-fg`, `--aq-muted`, `--aq-border`,
`--aq-code-bg`, `--aq-warn`, `--aq-danger`, `--aq-shadow` (and `--aq-accent-fg`),
and set `theme="light" | "dark" | "auto"`.

**Component props** - `<AskSqlChat>` takes `placeholder`, `suggestions`, `requireApproval`,
`showConnectionPicker`, `connectionId`, and `nonce` (CSP); `<AskSqlBubble>` adds `title`,
`icon`, `position`, `offset`, and `zIndex`. The vanilla widget's `AskSQL.mount()` takes the
same `theme` / `title` / `position` / `offset` / `zIndex`.

**Compose the building blocks** - `<ResultTable>`, `<SqlBlock>`, `<SchemaBrowser>`, and
`<ResultChart>` (plus the `formatCell` / `toCsv` helpers) are exported standalone, so you can
lay out your own surface while keeping our rendering.

**Go fully headless** - `useAskSql` (see [Headless](#headless) above) gives you the entire
ask -> approve -> run state machine with zero markup; render your own UI on top while the
engine and guard still run underneath. The hook also exposes `planFor()`, which runs
`EXPLAIN` through the guard and returns the database's own plan.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
