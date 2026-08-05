/**
 * Side panel: pick a connection, then chat against it. A connection is either
 * a data-file connection (its own DuckDB database, built in Settings) or an
 * @asksql/server sidecar. Both produce a Transport consumed by the same
 * <AskSqlChat/>, so nothing downstream cares which kind is active.
 */
import { StrictMode, useEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { createAskSql, resolveModel, type AskSqlEngine, type ModelLike } from '@asksql/core';
import type { DuckDbWasmConnector } from '@asksql/duckdb/browser';
import { AskSqlChat, HttpTransport, LocalTransport, SchemaBrowser, type Transport } from '@asksql/react';
import type { SchemaCatalog } from '@asksql/core';
import {
  getConnections,
  getEngineSettings,
  getLastConnectionId,
  getProviderSettings,
  setLastConnectionId,
  type SidecarConnection,
} from '../storage.js';
import { getFileConnections, openFileConnector, type FileConnection } from '../fileConnections.js';
import { ensureOriginAccess, permissionDeniedMessage } from '../originAccess.js';
import { providerOrigin } from '../providerOrigin.js';
import { ensureProviderOriginAccess } from '../providerAccess.js';
import { reportError } from '../errorReporting.js';
import { PENDING_QUESTION_KEY, PENDING_QUESTION_MAX_AGE_MS, type PendingQuestion } from '../constants.js';

// Escape hatch shared with examples/browser-duckdb: a test injects a CustomModel here.
declare global {
  interface Window {
    __asksqlModel?: ModelLike;
  }
}

type Choice =
  | { readonly kind: 'file'; readonly connection: FileConnection }
  | { readonly kind: 'sidecar'; readonly connection: SidecarConnection };

const choiceId = (c: Choice): string => c.connection.id;

async function connectProviderModel(provider: Awaited<ReturnType<typeof getProviderSettings>>): Promise<ModelLike> {
  if (window.__asksqlModel) return window.__asksqlModel;
  const origin = providerOrigin(provider);
  if (origin && !(await ensureProviderOriginAccess(origin))) {
    throw new Error(permissionDeniedMessage(origin));
  }
  return resolveModel({
    provider: provider.provider,
    model: provider.model,
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
  });
}

async function buildFileTransport(
  connection: FileConnection,
): Promise<{ transport: Transport; connector: DuckDbWasmConnector }> {
  const provider = await getProviderSettings();
  const engineSettings = await getEngineSettings();
  const model = await connectProviderModel(provider);

  const connector = await openFileConnector(connection);
  const catalog = await connector.introspect();
  if (catalog.tables.length === 0) {
    await connector.close();
    throw new Error(`"${connection.name}" has no tables left. Remove it and add the files again from Settings.`);
  }

  const engine: AskSqlEngine = createAskSql({
    connectors: [connector],
    model,
    policy: { maxRows: engineSettings.maxRows, allowFileFunctions: true },
    pruner: { maxSchemaTokens: engineSettings.maxSchemaTokens },
    ...(engineSettings.customInstructions.trim()
      ? { prompts: { instructions: engineSettings.customInstructions.trim() } }
      : {}),
  });
  return { transport: new LocalTransport(engine), connector };
}

async function buildSidecarTransport(connection: SidecarConnection): Promise<Transport> {
  if (!(await ensureOriginAccess(connection.baseUrl))) {
    throw new Error(permissionDeniedMessage(connection.baseUrl));
  }
  return new HttpTransport({
    baseUrl: connection.baseUrl,
    headers: connection.authHeader ? { Authorization: connection.authHeader } : undefined,
  });
}

function ConnectionPicker({
  choices,
  selected,
  onSelect,
  onConnect,
  connecting,
  status,
}: {
  choices: readonly Choice[];
  selected: string;
  onSelect: (id: string) => void;
  onConnect: () => void;
  connecting: boolean;
  status: string;
}): JSX.Element {
  if (choices.length === 0) {
    return (
      <div className="asksql-ext-setup">
        <p>
          No connections yet. Open Settings to add one - either a set of data files (CSV, Excel, Parquet, a .sql dump or
          a .zip of them) analyzed entirely in your browser, or an AskSQL server for a real database.
        </p>
        <button className="asksql-ext-btn" onClick={() => chrome.runtime.openOptionsPage()}>
          Open Settings
        </button>
      </div>
    );
  }

  return (
    <div className="asksql-ext-setup">
      <div className="asksql-ext-field">
        <label htmlFor="connection">Connection</label>
        <select id="connection" value={selected} onChange={(e) => onSelect(e.target.value)}>
          {choices.map((c) => (
            <option key={choiceId(c)} value={choiceId(c)}>
              {c.connection.name} {c.kind === 'file' ? '(data files)' : '(server)'}
            </option>
          ))}
        </select>
      </div>
      <button className="asksql-ext-btn" onClick={onConnect} disabled={connecting}>
        {connecting ? 'Connecting...' : 'Connect'}
      </button>
      <button className="asksql-ext-btn" onClick={() => chrome.runtime.openOptionsPage()}>
        Settings
      </button>
      {status && <p className="asksql-ext-status">{status}</p>}
    </div>
  );
}

function App(): JSX.Element {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [selected, setSelected] = useState('');
  const [transport, setTransport] = useState<Transport | null>(null);
  const [activeId, setActiveId] = useState('');
  const [status, setStatus] = useState('');
  const [readyNotice, setReadyNotice] = useState('');
  const [providerLabel, setProviderLabel] = useState('');
  const [catalog, setCatalog] = useState<SchemaCatalog | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showTables, setShowTables] = useState(false);
  const [seedQuestion, setSeedQuestion] = useState<string | undefined>(undefined);
  const [requireApproval, setRequireApproval] = useState(false);
  const [maxRows, setMaxRows] = useState<number | undefined>(undefined);
  const [sqlDisplayPlacement, setSqlDisplayPlacement] = useState<'before' | 'after'>('after');
  const [answerSchemaQuestions, setAnswerSchemaQuestions] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const openConnector = useRef<DuckDbWasmConnector | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Guards re-entry synchronously; the state above only drives the disabled attribute.
  const connectInFlight = useRef(false);

  const loadChoices = async () => {
    const [files, sidecars, last] = await Promise.all([getFileConnections(), getConnections(), getLastConnectionId()]);
    const next: Choice[] = [
      ...files.map((connection) => ({ kind: 'file' as const, connection })),
      ...sidecars.map((connection) => ({ kind: 'sidecar' as const, connection })),
    ];
    setChoices(next);
    setSelected((current) => {
      if (current && next.some((c) => choiceId(c) === current)) return current;
      if (last && next.some((c) => choiceId(c) === last)) return last;
      return next[0] ? choiceId(next[0]) : '';
    });
  };

  useEffect(() => {
    void loadChoices();

    const applyEngineSettings = () =>
      void getEngineSettings().then((s) => {
        setRequireApproval(s.requireApproval);
        setSqlDisplayPlacement(s.sqlDisplayPlacement);
        setAnswerSchemaQuestions(s.answerSchemaQuestions);
        setMaxRows(s.maxRows);
      });
    applyEngineSettings();

    const applyProviderLabel = () =>
      void getProviderSettings().then((p) => setProviderLabel(p.model ? `${p.provider} / ${p.model}` : p.provider));
    applyProviderLabel();

    const consumePending = (value: PendingQuestion | undefined) => {
      if (!value || Date.now() - value.ts > PENDING_QUESTION_MAX_AGE_MS) return;
      setPendingQuestion(value.question);
    };
    void chrome.storage.session.get(PENDING_QUESTION_KEY).then((got) => {
      consumePending(got[PENDING_QUESTION_KEY] as PendingQuestion | undefined);
      if (got[PENDING_QUESTION_KEY]) void chrome.storage.session.remove(PENDING_QUESTION_KEY);
    });

    // Live, not just at mount: an already-open panel must also pick up a fresh selection.
    const onSessionChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      const change = changes[PENDING_QUESTION_KEY];
      if (!change?.newValue) return;
      consumePending(change.newValue as PendingQuestion);
      void chrome.storage.session.remove(PENDING_QUESTION_KEY);
    };
    const onLocalChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes['asksql.engine']) applyEngineSettings();
      if (changes['asksql.provider']) applyProviderLabel();
      // Connections added or removed in Settings show up here without a reload.
      if (changes['asksql.fileConnections'] || changes['asksql.connections']) void loadChoices();
    };
    chrome.storage.onChanged.addListener(onSessionChanged);
    chrome.storage.onChanged.addListener(onLocalChanged);
    return () => {
      chrome.storage.onChanged.removeListener(onSessionChanged);
      chrome.storage.onChanged.removeListener(onLocalChanged);
      clearTimeout(dismissTimer.current);
    };
  }, []);

  const showReady = (notice: string) => {
    setReadyNotice(notice);
    clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(() => setReadyNotice(''), 10_000);
  };

  const connect = async (id: string) => {
    const choice = choices?.find((c) => choiceId(c) === id);
    if (!choice || connectInFlight.current) return;
    connectInFlight.current = true;
    setConnecting(true);
    setStatus(`Connecting to ${choice.connection.name}...`);
    try {
      // Build the new transport BEFORE closing the old connector, so a failure leaves the chat working.
      let next: { transport: Transport; connector: DuckDbWasmConnector | null };
      if (choice.kind === 'file') {
        const built = await buildFileTransport(choice.connection);
        next = { transport: built.transport, connector: built.connector };
      } else {
        next = { transport: await buildSidecarTransport(choice.connection), connector: null };
      }
      // Only now retire the previous database; two DuckDB handles on one OPFS file conflict.
      await openConnector.current
        ?.close()
        .catch((err: unknown) => console.warn('AskSQL: closing the previous connection failed', err));
      openConnector.current = next.connector;
      setTransport(next.transport);
      setActiveId(id);
      setCatalog(null);
      setStatus('');
      await setLastConnectionId(id);
      showReady(`Connected to ${choice.connection.name}.`);
      // Best-effort: a failed schema read must not block the connection.
      void (choice.kind === 'file' ? buildFileCatalog(choice.connection) : loadSidecarCatalog(choice.connection))
        .then(setCatalog)
        .catch((err: unknown) => console.warn('AskSQL: could not read the schema for the tables list', err));
    } catch (err) {
      setStatus(reportError(`Connect to ${choice.connection.name}`, err));
    } finally {
      connectInFlight.current = false;
      setConnecting(false);
    }
  };

  const buildFileCatalog = async (connection: FileConnection): Promise<SchemaCatalog> => {
    const c = openConnector.current;
    if (!c) throw new Error(`No open connector for "${connection.name}".`);
    return c.introspect();
  };

  const loadSidecarCatalog = async (connection: SidecarConnection, refresh = false): Promise<SchemaCatalog> => {
    const transport = new HttpTransport({
      baseUrl: connection.baseUrl,
      headers: connection.authHeader ? { Authorization: connection.authHeader } : undefined,
    });
    return transport.schema(connection.remoteConnectionId, refresh);
  };

  /** Re-read the schema of the open connection, picking up a table added elsewhere. */
  const refreshCatalog = async () => {
    const choice = choices?.find((c) => choiceId(c) === activeId);
    if (!choice || refreshing) return;
    setRefreshing(true);
    try {
      const fresh =
        choice.kind === 'file'
          ? await buildFileCatalog(choice.connection)
          : await loadSidecarCatalog(choice.connection, true);
      setCatalog(fresh);
      // An unchanged schema looks exactly like a refresh that did nothing.
      showReady(`Schema re-read: ${fresh.tables.length} ${fresh.tables.length === 1 ? 'table' : 'tables'}.`);
    } catch (err) {
      setStatus(reportError('Refresh schema', err));
    } finally {
      setRefreshing(false);
    }
  };

  const disconnect = async () => {
    try {
      await openConnector.current?.close();
      openConnector.current = null;
      setTransport(null);
      setActiveId('');
      setReadyNotice('');
      setStatus('');
    } catch (err) {
      setStatus(reportError('Disconnect', err));
    }
  };

  useEffect(() => {
    if (!activeId || choices === null || choices.some((c) => choiceId(c) === activeId)) return;
    // Removed in Settings while it was open: drop the dead transport.
    void disconnect().then(() => setStatus('That connection was removed in Settings.'));
  }, [choices, activeId]);

  if (choices === null) return <div className="asksql-ext-root">Loading...</div>;

  // The id the server knows this database by, shared by the chat and the schema pane.
  const active = choices.find((c) => choiceId(c) === activeId);
  const remoteConnectionId = active?.kind === 'sidecar' ? active.connection.remoteConnectionId : undefined;

  if (!transport) {
    return (
      <div className="asksql-ext-root">
        <header className="asksql-ext-header">
          <strong>AskSQL</strong>
        </header>
        <ConnectionPicker
          choices={choices}
          selected={selected}
          onSelect={setSelected}
          onConnect={() => void connect(selected)}
          connecting={connecting}
          status={status}
        />
      </div>
    );
  }

  return (
    <div className="asksql-ext-root asksql-ext-chat">
      <div className="asksql-ext-chat-header">
        <select
          aria-label="Connection"
          value={activeId}
          onChange={(e) => void connect(e.target.value)}
          disabled={choices.length < 2 || connecting}
        >
          {choices.map((c) => (
            <option key={choiceId(c)} value={choiceId(c)}>
              {c.connection.name}
            </option>
          ))}
        </select>
        {providerLabel && (
          <button
            className="asksql-ext-btn asksql-ext-linkish"
            title="Change the AI provider or model"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            <strong>AI:</strong> {providerLabel}
          </button>
        )}
        <button
          className="asksql-ext-btn"
          title="Browse tables, views and columns for this connection"
          onClick={() => setShowTables((v) => !v)}
        >
          {showTables ? 'Hide schema' : 'Schema'}
        </button>
        <button
          className="asksql-ext-btn"
          title="Add or manage connections"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          Settings
        </button>
        <button className="asksql-ext-btn" onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>
      {readyNotice && <p className="asksql-ext-status">{readyNotice}</p>}
      {showTables && (
        <div className="asksql-ext-tables">
          {catalog ? (
            <>
              <div className="asksql-ext-tables-head">
                <button
                  className="asksql-ext-btn"
                  onClick={() => void refreshCatalog()}
                  disabled={refreshing}
                  title="Re-read the schema from the database"
                >
                  {refreshing ? 'Refreshing...' : 'Refresh schema'}
                </button>
              </div>
              <SchemaBrowser catalog={catalog} onPick={(t) => setSeedQuestion(`Show me 10 rows from ${t.name}`)} />
            </>
          ) : (
            <p className="asksql-ext-status">Reading the schema...</p>
          )}
        </div>
      )}
      {status && <p className="asksql-ext-status">{status}</p>}
      <AskSqlChat
        // Remounts on a connection switch so one database's transcript never carries into another.
        key={activeId}
        transport={transport}
        connectionId={remoteConnectionId}
        // A server entry that names no database still offers its own picker.
        showConnectionPicker={!remoteConnectionId}
        requireApproval={requireApproval}
        // Sent with every query, so the row cap applies to a sidecar connection too.
        maxRows={maxRows}
        sqlDisplayPlacement={sqlDisplayPlacement}
        answerSchemaQuestions={answerSchemaQuestions}
        suggestions={pendingQuestion ? undefined : ['How many rows are there?', 'Show the first few rows']}
        initialQuestion={seedQuestion ?? pendingQuestion}
        onInitialQuestionConsumed={() => {
          setSeedQuestion(undefined);
          setPendingQuestion(undefined);
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
