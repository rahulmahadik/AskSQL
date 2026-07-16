/**
 * Zero-backend AskSQL: upload a file, ask questions, everything runs in the
 * browser. DuckDB-WASM analyzes the file in a Web Worker; the engine + guard
 * run client-side; only the schema-only prompt goes to your chosen LLM.
 *
 * Model: for real use, paste a Groq/OpenAI key (the call goes browser->provider
 * directly). For automated tests, a CustomModel can be injected as
 * `window.__asksqlModel` before the first upload.
 */
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createAskSql, resolveModel, type ModelLike } from '@asksql/core';
import { DuckDbWasmConnector, type DuckDbBundles } from '@asksql/duckdb/browser';
import { AskSqlChat, LocalTransport, type Transport } from '@asksql/react';

// Self-hosted DuckDB-WASM bundles (no CDN needed -> works offline + strict CSP).
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const BUNDLES: DuckDbBundles = {
  mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
  eh: { mainModule: ehWasm, mainWorker: ehWorker },
};

declare global {
  interface Window {
    __asksqlModel?: ModelLike;
    __asksql?: { DuckDbWasmConnector: typeof DuckDbWasmConnector; BUNDLES: DuckDbBundles };
  }
}

// Expose the connector for the OPFS/persistence browser test (harmless in prod).
if (typeof window !== 'undefined') {
  window.__asksql = { DuckDbWasmConnector, BUNDLES };
}

function App() {
  const [transport, setTransport] = useState<Transport | null>(null);
  const [status, setStatus] = useState('');
  const [apiKey, setApiKey] = useState('');

  const onFile = async (file: File) => {
    setStatus(`Loading ${file.name} into DuckDB-WASM...`);
    try {
      const table = file.name.replace(/\.[^.]+$/, '');
      const connector = new DuckDbWasmConnector({
        id: 'files',
        name: 'Uploaded files',
        bundles: BUNDLES,
        files: [{ table, data: file, filename: file.name }],
      });
      await connector.connect();
      const model = window.__asksqlModel ?? (await resolveModel({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey }));
      const engine = createAskSql({ connectors: [connector], model, policy: { maxRows: 200 } });
      setTransport(new LocalTransport(engine));
      setStatus(`Ready - ask about "${table}". Nothing left your browser.`);
    } catch (err) {
      setStatus(`Couldn't load the file: ${(err as { userMessage?: string }).userMessage ?? String(err)}`);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="bar">
        <strong>AskSQL</strong>
        <small>zero backend · DuckDB-WASM · data never leaves the tab</small>
        <input
          data-testid="file"
          type="file"
          accept=".csv,.json,.ndjson,.parquet,.xlsx,.sql"
          onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
        />
        {!window.__asksqlModel && (
          <input
            type="password"
            placeholder="Groq API key (for real use)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            style={{ padding: '4px 8px' }}
          />
        )}
        <small data-testid="status">{status}</small>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {transport ? (
          <AskSqlChat transport={transport} showConnectionPicker={false} suggestions={['How many rows are there?', 'Show the first few rows']} />
        ) : (
          <div style={{ padding: 40, color: '#6b7280' }}>Upload a CSV / JSON / Parquet / SQL file to begin.</div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
