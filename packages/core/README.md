# @asksql/core

The AskSQL engine: schema catalog, AST-based read-only SQL guard, the natural
language to SQL pipeline, and the model provider resolver. No database drivers
and no UI; those live in the adapter packages.

```bash
npm i @asksql/core
```

```ts
import { createAskSql, resolveModel } from '@asksql/core';

const model = await resolveModel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey });
const engine = createAskSql({ connectors: [/* @asksql/postgres, mysql, ... */], model });

const answer = await engine.ask('How many customers signed up this month?');
console.log(answer.sql);           // review before running
const result = await answer.run(); // guarded, read-only execution
```

The model only ever receives your schema and the question, never your data.
Every generated statement passes a deterministic AST guard before it can run.

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)
