# @asksql/react

React components and hooks for [AskSQL](https://github.com/rahulmahadik/AskSQL):

- `<AskSqlChat />`: full-page chat with SQL review, results table, charts.
- `<AskSqlBubble />`: floating chat head you can drop into any app.
- `useAskSql`: headless hook exposing the whole ask / approve / run state
  machine, for building your own UI.
- Building blocks: `<ResultTable />`, `<SqlBlock />`, `<SchemaBrowser />`,
  `<ResultChart />`.

Light and dark themes, CSS-variable theming, CSP nonce support.

![AskSQL React chat: a plain-language question turned into SQL, with the results and a chart below it](https://github.com/rahulmahadik/AskSQL/raw/HEAD/docs/screenshots/02-results-table-light.png)

Turn on `answerSchemaQuestions` and questions that aren't a data query - "how are the tables related?", "summarize this database", even "how would I add an index?" - get a grounded, read-only explanation from the schema instead of an error. No query is run, and names it can't find are flagged:

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

`useAskSql` is a conversation of `turns`; each turn carries its own `sql`, `result`, `error`, etc.

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

## Reaching the server

When the sidecar is unreachable (wrong `baseUrl`, server down, or a **CORS** rejection), the transport
surfaces a typed error with `code: 'NETWORK_ERROR'` and an actionable `userMessage`, distinct from an
HTTP error the server returned. The components render it inline; with the hook, read it from the turn's
`error.userMessage`. If you see `NETWORK_ERROR` in the browser, check that `baseUrl` is correct and that
the server allows the page's origin (CORS).

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
