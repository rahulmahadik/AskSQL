# @asksql/widget

The vanilla-JavaScript embed for [AskSQL](https://github.com/rahulmahadik/AskSQL): ask a database
questions in plain language from any web page, React or not. The chat renders inside a **shadow root**,
so your page's CSS and the widget's CSS never collide.

![AskSQL widget: a CSV queried entirely in the browser with DuckDB-WASM, question to SQL to results, nothing leaving the tab](https://github.com/rahulmahadik/AskSQL/raw/HEAD/docs/screenshots/07-browser-duckdb.png)

## Use it with a script tag

The browser build is self-contained (React and react-dom are bundled in, nothing else to load):

```html
<div id="asksql"></div>

<script src="https://unpkg.com/@asksql/widget"></script>
<script>
  AskSQL.mount({
    target: '#asksql',      // omit for a floating bubble on document.body
    serverUrl: '/asksql',   // your @asksql/server sidecar
    theme: 'auto',          // 'light' | 'dark' | 'auto'
  });
</script>
```

`mount()` returns a handle with `unmount()` to remove the widget again.

## Use it from a bundler

```bash
npm install @asksql/widget
```

```js
import { mount } from '@asksql/widget';

const widget = mount({ target: '#asksql', serverUrl: '/asksql' });
// later: widget.unmount();
```

## What it needs

The widget talks to an **[`@asksql/server`](https://www.npmjs.com/package/@asksql/server)** sidecar at
`serverUrl`: that is where your database connections and model credentials live. Nothing sensitive is
shipped to the browser. If the widget cannot reach the server it reports a network/CORS error rather
than failing silently; make sure `serverUrl` is reachable from the page and that the server allows the
page's origin (CORS).

## Options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `serverUrl` | `string` | — | Required. The `@asksql/server` base URL. |
| `target` | `string \| HTMLElement` | floating bubble | CSS selector or element to mount into. |
| `headers` | `Record<string,string>` | — | Extra request headers (e.g. an auth token). |
| `connectionId` | `string` | server default | Pin the widget to one connection. |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'auto'` | Colour scheme. |
| `requireApproval` | `boolean` | `false` | Gate every query behind a Run button. |

Full documentation: [https://github.com/rahulmahadik/AskSQL](https://github.com/rahulmahadik/AskSQL)

API reference: [rahulmahadik.github.io/AskSQL](https://rahulmahadik.github.io/AskSQL/)
