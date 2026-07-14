# @asksql/react

React components and hooks for [AskSQL](https://github.com/rahulmahadik/AskSQL):

- `<AskSqlChat />`: full page chat with SQL review, results table, charts.
- `<AskSqlBubble />`: floating chat head you can drop into any app.
- `useAskSql`: headless hook exposing the whole ask / approve / run state
  machine, for building your own UI.
- Building blocks: `<ResultTable />`, `<SqlBlock />`, `<SchemaBrowser />`,
  `<ResultChart />`.

Light and dark themes, CSS-variable theming, CSP nonce support.

```bash
npm i @asksql/core @asksql/react
```

```tsx
import { AskSqlChat, HttpTransport } from '@asksql/react';

const transport = new HttpTransport({ baseUrl: '/asksql' });
<AskSqlChat transport={transport} />
```

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
