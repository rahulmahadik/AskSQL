/**
 * Options page: provider/model/key, engine settings, sidecar connections,
 * Reset, and Collect Diagnostics.
 */
import { StrictMode, useEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { assertBaseUrl, type ProviderName } from '@asksql/core';
import { HttpTransport } from '@asksql/react';
import {
  addConnection,
  boundedInt,
  ENGINE_LIMITS,
  getConnections,
  getEngineSettings,
  getProviderSettings,
  getWarningAcknowledged,
  removeConnection,
  resetAll,
  resetSettingsToDefaults,
  setEngineSettings,
  setProviderSettings,
  setWarningAcknowledged,
  type EngineSettings,
  type ProviderSettings,
  type SidecarConnection,
} from '../storage.js';
import { ensureOriginAccess, permissionDeniedMessage } from '../originAccess.js';
import { providerOrigin } from '../providerOrigin.js';
import { ensureProviderOriginAccess } from '../providerAccess.js';
import { testProviderConnectivity } from '../testProvider.js';
import { fetchProviderModels, listableBaseUrl } from '../listModels.js';
import { reportError } from '../errorReporting.js';
import { installCommand, probeServer, serveCommand, type ServerState } from '../serverStatus.js';
import {
  createRemoteDatabaseConnection,
  testRemoteDatabaseConnection,
  DATABASE_ENGINES,
  defaultsFor,
  ENGINE_PROFILES,
  type DatabaseEngine,
  type DatabaseForm,
} from '../databaseConnections.js';
import {
  ACCEPTED_UPLOAD_EXTENSIONS,
  createFileConnection,
  deleteFileConnection,
  getFileConnections,
  renameFileConnection,
  type FileConnection,
} from '../fileConnections.js';

const PROVIDERS: ProviderName[] = [
  'ollama',
  'groq',
  'nvidia',
  'openai',
  'anthropic',
  'google',
  'azure',
  'openai-compatible',
];

// azure has no fixed host and openai-compatible is a generic passthrough; the rest have defaults.
const BASE_URL_PLACEHOLDER: Readonly<Record<ProviderName, string>> = {
  ollama: 'http://localhost:11434/v1',
  groq: '',
  nvidia: '',
  openai: '',
  anthropic: '',
  google: '',
  azure: 'https://<resource>.openai.azure.com',
  'openai-compatible': 'e.g. http://localhost:1234/v1',
};

function newId(): string {
  return `conn_${Math.random().toString(36).slice(2, 10)}`;
}

function ProviderSection({
  provider,
  onChange,
}: {
  provider: ProviderSettings;
  onChange: (p: ProviderSettings) => void;
}): JSX.Element {
  const [warningAcknowledged, setWarningAckLocal] = useState(true);
  const [status, setStatus] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsStatus, setModelsStatus] = useState('');
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    void getWarningAcknowledged().then(setWarningAckLocal);
  }, []);

  useEffect(() => {
    setModels(null);
    setModelsStatus('');
  }, [provider.provider, provider.baseURL]);

  // Ollama is the one provider that never authenticates; an openai-compatible gateway usually does.
  const needsKey = provider.provider !== 'ollama';
  const canListModels = Boolean(listableBaseUrl(provider.provider, provider.baseURL));
  const baseUrlRequired = provider.provider === 'azure' || provider.provider === 'openai-compatible';

  const fetchModels = async () => {
    setModelsStatus('Looking up models...');
    setModels(null);
    try {
      const found = await fetchProviderModels(provider.provider, provider.baseURL, provider.apiKey);
      setModels(found);
      setModelsStatus(found.length === 0 ? 'No models found at that endpoint.' : '');
    } catch (err) {
      setModelsStatus(reportError('Fetch models', err));
    }
  };

  // Edits stay local until Save, so a half-typed model name never becomes the active setting.
  const edit = (next: ProviderSettings) => {
    onChange(next);
    setSaved(false);
    setStatus('');
  };

  const save = async () => {
    try {
      if (provider.apiKey && !warningAcknowledged) {
        await setWarningAcknowledged(true);
        setWarningAckLocal(true);
      }
      await setProviderSettings(provider);
      setSaved(true);
      setStatus('Saved.');
    } catch (err) {
      setStatus(reportError('Save provider settings', err));
    }
  };

  const test = async () => {
    if (!provider.model.trim()) {
      setStatus('Enter a model name first (or use Fetch models to pick one).');
      return;
    }
    setStatus('Testing...');
    try {
      const origin = providerOrigin(provider);
      if (origin && !(await ensureProviderOriginAccess(origin))) {
        setStatus(permissionDeniedMessage(origin));
        return;
      }
      await testProviderConnectivity({
        provider: provider.provider,
        model: provider.model,
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
      });
      setStatus('Provider responded successfully.');
    } catch (err) {
      setStatus(reportError('Test provider', err));
    }
  };

  return (
    <div className="asksql-ext-section">
      <h2>AI provider</h2>
      {!warningAcknowledged && needsKey && (
        <div className="asksql-ext-warning">
          API keys are stored in this browser profile's local storage, which is not encrypted at rest (there is no OS
          keychain available to a browser extension). Only enter a key you're comfortable with that tradeoff.
        </div>
      )}
      <div className="asksql-ext-field">
        <label htmlFor="provider">Provider</label>
        <select
          id="provider"
          value={provider.provider}
          // Key and endpoint belong to the provider they were entered for, so they do not carry over.
          onChange={(e) => edit({ provider: e.target.value as ProviderName, model: provider.model })}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="asksql-ext-field">
        <label htmlFor="model">Model</label>
        <input
          id="model"
          type="text"
          value={provider.model}
          placeholder="e.g. llama-3.3-70b-versatile"
          onChange={(e) => edit({ ...provider, model: e.target.value })}
        />
        {canListModels && (
          <button type="button" className="asksql-ext-btn" onClick={() => void fetchModels()}>
            Fetch models
          </button>
        )}
        {models && models.length > 0 && (
          <select
            aria-label="Discovered models"
            value=""
            onChange={(e) => e.target.value && edit({ ...provider, model: e.target.value })}
          >
            <option value="" disabled>
              {models.length} model{models.length === 1 ? '' : 's'} found - pick one
            </option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        )}
        {modelsStatus && <p className="asksql-ext-status">{modelsStatus}</p>}
      </div>
      <div className="asksql-ext-field">
        <label htmlFor="baseURL">Base URL {baseUrlRequired ? '(required)' : '(optional override)'}</label>
        <input
          id="baseURL"
          type="text"
          value={provider.baseURL ?? ''}
          placeholder={BASE_URL_PLACEHOLDER[provider.provider]}
          onChange={(e) => edit({ ...provider, baseURL: e.target.value || undefined })}
        />
      </div>
      {needsKey && (
        <div className="asksql-ext-field">
          <label htmlFor="apiKey">API key</label>
          <input
            id="apiKey"
            type="password"
            value={provider.apiKey ?? ''}
            onChange={(e) => edit({ ...provider, apiKey: e.target.value || undefined })}
          />
        </div>
      )}
      <div className="asksql-ext-actions">
        <button className="asksql-ext-btn" disabled={saved} onClick={() => void save()}>
          {saved ? 'Saved' : 'Save'}
        </button>
        <button className="asksql-ext-btn" onClick={() => void test()}>
          Test provider
        </button>
      </div>
      {!saved && <p className="asksql-ext-status">Unsaved changes - Save before testing.</p>}
      {status && <p className="asksql-ext-status">{status}</p>}
    </div>
  );
}

function EngineSection({
  engine,
  onChange,
}: {
  engine: EngineSettings;
  onChange: (e: EngineSettings) => void;
}): JSX.Element {
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState(true);

  const edit = (next: EngineSettings) => {
    onChange(next);
    setSaved(false);
    setStatus('');
  };

  const save = async () => {
    try {
      await setEngineSettings(engine);
      setSaved(true);
      setStatus('Saved.');
    } catch (err) {
      setStatus(reportError('Save engine settings', err));
    }
  };
  return (
    <div className="asksql-ext-section">
      <h2>Engine</h2>
      <div className="asksql-ext-field">
        <label htmlFor="maxRows">Row cap</label>
        <input
          id="maxRows"
          type="number"
          min={ENGINE_LIMITS.maxRows.min}
          max={ENGINE_LIMITS.maxRows.max}
          value={engine.maxRows}
          onChange={(e) =>
            edit({ ...engine, maxRows: boundedInt(e.target.value, ENGINE_LIMITS.maxRows, engine.maxRows) })
          }
        />
      </div>
      <label className="asksql-ext-checkbox">
        <input
          type="checkbox"
          checked={engine.requireApproval}
          onChange={(e) => edit({ ...engine, requireApproval: e.target.checked })}
        />
        Require a Run click before a generated query executes
      </label>
      <div className="asksql-ext-field">
        <label htmlFor="sqlDisplay">SQL placement</label>
        <select
          id="sqlDisplay"
          value={engine.sqlDisplayPlacement}
          onChange={(e) => edit({ ...engine, sqlDisplayPlacement: e.target.value as 'before' | 'after' })}
        >
          <option value="before">Before results</option>
          <option value="after">After results</option>
        </select>
      </div>
      <label className="asksql-ext-checkbox">
        <input
          type="checkbox"
          checked={engine.answerSchemaQuestions}
          onChange={(e) => edit({ ...engine, answerSchemaQuestions: e.target.checked })}
        />
        Answer schema questions in plain language when a question isn't a data query
      </label>
      <div className="asksql-ext-field">
        <label htmlFor="maxSchemaTokens">Schema budget (tokens per question)</label>
        <input
          id="maxSchemaTokens"
          type="number"
          min={ENGINE_LIMITS.maxSchemaTokens.min}
          max={ENGINE_LIMITS.maxSchemaTokens.max}
          value={engine.maxSchemaTokens}
          onChange={(e) =>
            edit({
              ...engine,
              maxSchemaTokens: boundedInt(e.target.value, ENGINE_LIMITS.maxSchemaTokens, engine.maxSchemaTokens),
            })
          }
        />
        <p className="asksql-ext-status">
          Applies to data file connections. A sidecar builds its own prompts, so it uses the budget configured on the
          server.
        </p>
      </div>
      <div className="asksql-ext-field">
        <label htmlFor="customInstructions">Custom instructions</label>
        <textarea
          id="customInstructions"
          rows={4}
          value={engine.customInstructions}
          placeholder="e.g. Prefer the reporting views over raw tables."
          onChange={(e) => edit({ ...engine, customInstructions: e.target.value })}
        />
        <p className="asksql-ext-status">
          <strong>Added to</strong> the built-in rules, not a replacement for them. Read-only is enforced by a SQL guard
          after generation, so nothing written here can allow a write. Applies to data file connections - a sidecar
          builds its own prompts, so instructions for it go in the server's configuration.
        </p>
      </div>
      <p className="asksql-ext-status">
        Sampling real column values to help the model match casing/spelling isn't available in this extension: it's a
        per-connector setting configured only on a running @asksql/server sidecar, not something this options page can
        control.
      </p>
      <button className="asksql-ext-btn" disabled={saved} onClick={() => void save()}>
        {saved ? 'Saved' : 'Save'}
      </button>
      {!saved && <p className="asksql-ext-status">Unsaved changes.</p>}
      {status && <p className="asksql-ext-status">{status}</p>}
    </div>
  );
}

type ConnectionKind = 'files' | 'database' | 'server';

/** One row in the unified list, so both kinds render and delete through the same code path. */
interface ConnectionRow {
  readonly id: string;
  readonly kind: ConnectionKind;
  readonly name: string;
  readonly detail: string;
}

/** A database connection needs a local AskSQL server - it opens the socket the browser cannot, including for cloud databases; this panel makes that setup step visible and checkable. */
function ServerSetup({ baseUrl, provider }: { baseUrl: string; provider: ProviderSettings }): JSX.Element {
  const [state, setState] = useState<ServerState>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);
  const command = serveCommand(provider);

  // Keystrokes in the URL field fire overlapping probes; only the newest may win.
  const probeSeq = useRef(0);
  const probe = async () => {
    const seq = ++probeSeq.current;
    setState({ kind: 'checking' });
    const result = await probeServer(baseUrl);
    if (probeSeq.current === seq) setState(result);
  };

  useEffect(() => {
    void probe();
    // Re-probe when the target changes, so the badge never describes a stale URL.
  }, [baseUrl]);

  // Only a user gesture may raise the permission prompt, so the click requests access then probes.
  const check = async () => {
    try {
      await ensureOriginAccess(baseUrl.trim());
    } catch {
      // Invalid URL: the probe below reports idle/unreachable, which is the truth.
    }
    await probe();
  };

  const copy = () => {
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (err: unknown) => console.error('AskSQL: could not copy the command', err),
    );
  };

  return (
    <div className={state.kind === 'running' ? 'asksql-ext-section-inline' : 'asksql-ext-warning'}>
      <p>
        <strong>
          {state.kind === 'running'
            ? `AskSQL server is running (${state.databases} database(s))`
            : state.kind === 'checking'
              ? 'Checking for an AskSQL server...'
              : 'No AskSQL server is running'}
        </strong>
      </p>
      <p>
        {state.kind === 'running'
          ? 'Keep that terminal open while you use a database connection. If it stops, start it again with:'
          : "A browser extension can't open a database socket, so a small server on your machine makes the connection - for cloud databases too. Run this in a terminal and leave it open:"}
      </p>
      <pre className="asksql-ext-command">{command}</pre>
      {!provider.model.trim() && (
        <p className="asksql-ext-status">Pick a model above first - the command carries a placeholder until you do.</p>
      )}
      {state.kind !== 'running' && (
        <p className="asksql-ext-status">
          Needs{' '}
          <a href="https://nodejs.org" target="_blank" rel="noreferrer">
            Node.js
          </a>{' '}
          20 or newer. Prefer installing it once? <code>{installCommand()}</code> (or the pnpm/yarn equivalent), then
          run <code>asksql serve …</code> directly.
        </p>
      )}
      <div className="asksql-ext-actions">
        <button className="asksql-ext-btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy command'}
        </button>
        <button className="asksql-ext-btn" onClick={() => void check()}>
          {state.kind === 'checking' ? 'Checking...' : 'Check again'}
        </button>
      </div>
      {state.kind !== 'running' && (
        <p className="asksql-ext-status">
          The model above is used for data file connections. A database connection uses the model the server was started
          with - that's why it appears in the command.
        </p>
      )}
    </div>
  );
}

function ConnectionsSection({ provider }: { provider: ProviderSettings }): JSX.Element {
  const [fileConnections, setFileConnections] = useState<FileConnection[]>([]);
  const [servers, setServers] = useState<SidecarConnection[]>([]);
  const [kind, setKind] = useState<ConnectionKind>('files');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [databases, setDatabases] = useState<Record<string, string>>({});
  const [db, setDb] = useState<DatabaseForm>(() => defaultsFor('postgres'));
  /** Non-null while editing an existing entry; Add becomes Save changes. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Removing a data file connection deletes its data, so it is confirmed in place rather than acted on immediately. */
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  useEffect(() => {
    void getFileConnections().then(setFileConnections);
    void getConnections().then(setServers);
  }, []);

  const rows: ConnectionRow[] = [
    ...fileConnections.map((c) => ({
      id: c.id,
      kind: 'files' as const,
      name: c.name,
      detail: `data files - ${c.tables.length} table(s): ${c.tables.join(', ')}`,
    })),
    ...servers.map((c) => ({
      id: c.id,
      kind: 'server' as const,
      name: c.name,
      detail: databases[c.id] ?? `AskSQL server - ${c.baseUrl}`,
    })),
  ];

  const clearForm = () => {
    setEditingId(null);
    setName('');
    setFiles([]);
    setBaseUrl('');
    setAuthHeader('');
    setDb(defaultsFor('postgres'));
    setStatus('');
  };

  /** Editing covers only what this browser owns: the display name, plus URL/auth header for a server entry. Changing a database's host or credentials means remove and re-add. */
  const startEdit = (row: ConnectionRow) => {
    setEditingId(row.id);
    setName(row.name);
    setStatus('');
    if (row.kind === 'files') {
      setKind('files');
      return;
    }
    const server = servers.find((s2) => s2.id === row.id);
    setKind('server');
    setBaseUrl(server?.baseUrl ?? '');
    setAuthHeader(server?.authHeader ?? '');
  };

  const saveEdit = async () => {
    const existingFile = fileConnections.find((c) => c.id === editingId);
    if (existingFile) {
      setFileConnections(await renameFileConnection(existingFile.id, name.trim()));
      setStatus(`Renamed to "${name.trim()}".`);
      clearForm();
      return;
    }
    const server = servers.find((c) => c.id === editingId);
    if (!server) {
      setStatus('That connection no longer exists.');
      clearForm();
      return;
    }
    const trimmedUrl = baseUrl.trim();
    const trimmedAuth = authHeader.trim();
    assertBaseUrl(trimmedUrl, Boolean(trimmedAuth));
    setServers(
      await addConnection({
        ...server,
        name: name.trim(),
        baseUrl: trimmedUrl,
        authHeader: trimmedAuth || undefined,
      }),
    );
    setStatus(`Updated "${name.trim()}".`);
    clearForm();
  };

  const addFiles = async () => {
    const { connection, connections, skipped, renamed } = await createFileConnection(name, files, setStatus);
    setFileConnections(connections);
    const skippedNote =
      skipped.length > 0 ? ` Skipped ${skipped.length} unsupported file(s): ${skipped.join(', ')}.` : '';
    const renamedNote = renamed.length > 0 ? ` Renamed to keep names unique: ${renamed.join(', ')}.` : '';
    setStatus(`Added "${connection.name}" with ${connection.tables.length} table(s).${skippedNote}${renamedNote}`);
  };

  const addServer = async () => {
    const trimmedUrl = baseUrl.trim();
    const trimmedAuth = authHeader.trim();
    assertBaseUrl(trimmedUrl, Boolean(trimmedAuth));
    setServers(
      await addConnection({
        id: newId(),
        name: name.trim(),
        baseUrl: trimmedUrl,
        authHeader: trimmedAuth || undefined,
      }),
    );
    setBaseUrl('');
    setAuthHeader('');
    setStatus('Connection added. Use Test to see which databases it exposes.');
  };

  const addDatabase = async () => {
    if (!(await ensureOriginAccess(baseUrl.trim()))) {
      throw new Error(permissionDeniedMessage(baseUrl.trim()));
    }
    const created = await createRemoteDatabaseConnection(
      baseUrl.trim(),
      authHeader.trim() || undefined,
      name.trim(),
      db,
    );
    setServers(
      await addConnection({
        id: newId(),
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        authHeader: authHeader.trim() || undefined,
        remoteConnectionId: created.remoteConnectionId,
        engine: created.engine,
        database: created.database,
      }),
    );
    setDb((f) => ({ ...defaultsFor(f.engine) }));
    setStatus(`Connected "${name.trim()}" (${created.engine}${created.database ? ` · ${created.database}` : ''}).`);
  };

  const testDatabase = async () => {
    if (!baseUrl.trim()) {
      setStatus('Enter the base URL of your AskSQL server.');
      return;
    }
    setBusy(true);
    setStatus('Testing...');
    try {
      if (!(await ensureOriginAccess(baseUrl.trim()))) {
        setStatus(permissionDeniedMessage(baseUrl.trim()));
        return;
      }
      setStatus(await testRemoteDatabaseConnection(baseUrl.trim(), authHeader.trim() || undefined, db));
    } catch (err) {
      setStatus(reportError('Test connection', err));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!name.trim()) {
      setStatus('Give this connection a name.');
      return;
    }
    if (editingId) {
      setBusy(true);
      try {
        await saveEdit();
      } catch (err) {
        setStatus(reportError('Save changes', err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (kind === 'files' && files.length === 0) {
      setStatus('Choose at least one data file.');
      return;
    }
    if (kind !== 'files' && !baseUrl.trim()) {
      setStatus('Enter the base URL of your AskSQL server.');
      return;
    }
    if (kind === 'database' && !db.database.trim()) {
      setStatus(`Enter the ${ENGINE_PROFILES[db.engine].databaseLabel.toLowerCase()}.`);
      return;
    }
    setBusy(true);
    try {
      if (kind === 'files') await addFiles();
      else if (kind === 'database') await addDatabase();
      else await addServer();
      setName('');
      setFiles([]);
    } catch (err) {
      setStatus(reportError('Add connection', err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: ConnectionRow) => {
    setConfirmingRemove(null);
    try {
      if (row.kind === 'files') {
        setFileConnections(await deleteFileConnection(row.id));
        setStatus(`Removed "${row.name}" and deleted its data.`);
      } else {
        setServers(await removeConnection(row.id));
        setStatus(`Removed "${row.name}".`);
      }
    } catch (err) {
      setStatus(reportError('Remove connection', err));
    }
  };

  /** Shows which databases a server actually exposes - the equivalent of picking a data source in JetBrains. */
  const test = async (connection: SidecarConnection) => {
    setStatus(`Testing ${connection.name}...`);
    try {
      if (!(await ensureOriginAccess(connection.baseUrl))) {
        setStatus(permissionDeniedMessage(connection.baseUrl));
        return;
      }
      const transport = new HttpTransport({
        baseUrl: connection.baseUrl,
        headers: connection.authHeader ? { Authorization: connection.authHeader } : undefined,
      });
      const found = await transport.listConnections();
      const described = found.map((c) => `${c.name} (${c.engine}${c.database ? ` · ${c.database}` : ''})`);
      setDatabases((prev) => ({
        ...prev,
        [connection.id]:
          described.length > 0 ? `databases: ${described.join(', ')}` : `AskSQL server - ${connection.baseUrl}`,
      }));
      setStatus(
        described.length > 0
          ? `${connection.name} is reachable and exposes ${described.length} database(s): ${described.join(', ')}.`
          : `${connection.name} is reachable but exposes no databases you can query.`,
      );
    } catch (err) {
      setStatus(reportError(`Test connection "${connection.name}"`, err));
    }
  };

  return (
    <div className="asksql-ext-section">
      <h2>Connections</h2>
      <p className="asksql-ext-status">
        Add data files to query in your browser, or point at an AskSQL server for a real database. Both appear in the
        side panel's connection dropdown. A browser extension cannot open a database socket itself, so host, port and
        credentials for a real database live on the AskSQL server you run - not here.
      </p>
      {rows.map((row) => (
        <div className="asksql-ext-connection-row" key={row.id}>
          <span>
            {row.name} - {row.detail}
          </span>
          {row.kind === 'server' && (
            <button className="asksql-ext-btn" onClick={() => void test(servers.find((s) => s.id === row.id)!)}>
              Test
            </button>
          )}
          {confirmingRemove === row.id ? (
            <>
              <span className="asksql-ext-status">
                {row.kind === 'files' ? 'Delete this connection and its data?' : 'Remove this connection?'}
              </span>
              <button className="asksql-ext-btn" onClick={() => void remove(row)}>
                {row.kind === 'files' ? 'Delete' : 'Remove'}
              </button>
              <button className="asksql-ext-btn" onClick={() => setConfirmingRemove(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="asksql-ext-btn" onClick={() => startEdit(row)}>
                Edit
              </button>
              <button className="asksql-ext-btn" onClick={() => setConfirmingRemove(row.id)}>
                Remove
              </button>
            </>
          )}
        </div>
      ))}
      {editingId && (
        <p className="asksql-ext-status">
          Editing an existing connection. A data file connection's files, and a database's host and credentials, are
          fixed once created - remove and re-add to change those.
        </p>
      )}
      <div className="asksql-ext-field" hidden={Boolean(editingId)}>
        <label htmlFor="connType">Add</label>
        <select
          id="connType"
          value={kind}
          onChange={(e) => {
            const next = e.target.value as ConnectionKind;
            setKind(next);
            // `asksql serve` listens here by default, so most people never edit it.
            if (next === 'database' && !baseUrl.trim()) setBaseUrl('http://localhost:3000');
          }}
        >
          <option value="files">Data files (queried in this browser)</option>
          <option value="database">Database (PostgreSQL, MySQL, Oracle, SQLite, DuckDB)</option>
          <option value="server">AskSQL server (use every database it already exposes)</option>
        </select>
      </div>
      <div className="asksql-ext-field">
        <label htmlFor="connName">Name</label>
        <input
          id="connName"
          type="text"
          value={name}
          placeholder={kind === 'files' ? 'e.g. Q1 sales export' : 'e.g. Staging warehouse'}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {kind === 'database' && !editingId && (
        <>
          <ServerSetup baseUrl={baseUrl} provider={provider} />
          <div className="asksql-ext-field">
            <label htmlFor="dbEngine">Engine</label>
            <select
              id="dbEngine"
              value={db.engine}
              onChange={(e) => setDb(defaultsFor(e.target.value as DatabaseEngine))}
            >
              {DATABASE_ENGINES.map((e) => (
                <option key={e} value={e}>
                  {ENGINE_PROFILES[e].label}
                </option>
              ))}
            </select>
          </div>
          {ENGINE_PROFILES[db.engine].usesUri && (
            <div className="asksql-ext-field">
              <label htmlFor="dbUri">Connection string</label>
              <input
                id="dbUri"
                type="text"
                value={db.uri}
                placeholder="mongodb://localhost:27017"
                onChange={(e) => setDb({ ...db, uri: e.target.value })}
              />
            </div>
          )}
          {!ENGINE_PROFILES[db.engine].usesFilePath && !ENGINE_PROFILES[db.engine].usesUri && (
            <>
              <div className="asksql-ext-field">
                <label htmlFor="dbHost">Host</label>
                <input
                  id="dbHost"
                  type="text"
                  value={db.host}
                  onChange={(e) => setDb({ ...db, host: e.target.value })}
                />
              </div>
              <div className="asksql-ext-field">
                <label htmlFor="dbPort">Port</label>
                <input
                  id="dbPort"
                  type="number"
                  value={db.port}
                  onChange={(e) => setDb({ ...db, port: e.target.value })}
                />
              </div>
            </>
          )}
          <div className="asksql-ext-field">
            <label htmlFor="dbName">{ENGINE_PROFILES[db.engine].databaseLabel}</label>
            <input
              id="dbName"
              type="text"
              value={db.database}
              onChange={(e) => setDb({ ...db, database: e.target.value })}
            />
          </div>
          {!ENGINE_PROFILES[db.engine].usesFilePath && (
            <>
              <div className="asksql-ext-field">
                <label htmlFor="dbUser">User</label>
                <input
                  id="dbUser"
                  type="text"
                  value={db.user}
                  onChange={(e) => setDb({ ...db, user: e.target.value })}
                />
              </div>
              <div className="asksql-ext-field">
                <label htmlFor="dbPassword">Password</label>
                <input
                  id="dbPassword"
                  type="password"
                  value={db.password}
                  onChange={(e) => setDb({ ...db, password: e.target.value })}
                />
              </div>
            </>
          )}
          {ENGINE_PROFILES[db.engine].supportsSsl && (
            <div className="asksql-ext-field">
              <label htmlFor="dbSsl">Encryption</label>
              <select
                id="dbSsl"
                value={db.ssl}
                onChange={(e) => setDb({ ...db, ssl: e.target.value as DatabaseForm['ssl'] })}
              >
                <option value="trust">Encrypted, no certificate check</option>
                <option value="verify">Encrypted, verify certificate</option>
                <option value="disable">Not encrypted</option>
              </select>
            </div>
          )}
          <div className="asksql-ext-warning">
            The password is sent to the AskSQL server below, which opens the database and keeps the credentials. This
            browser stores only the server URL and the id it hands back - never the password.
          </div>
        </>
      )}
      {kind === 'files' ? (
        <div className="asksql-ext-field" hidden={Boolean(editingId)}>
          <label htmlFor="connFiles">Files</label>
          <input
            id="connFiles"
            type="file"
            multiple
            accept={ACCEPTED_UPLOAD_EXTENSIONS}
            onChange={(e) => setFiles(e.target.files ? [...e.target.files] : [])}
          />
        </div>
      ) : (
        <>
          <div className="asksql-ext-field">
            <label htmlFor="connUrl">AskSQL server base URL</label>
            <input
              id="connUrl"
              type="text"
              value={baseUrl}
              placeholder="http://localhost:3000/asksql"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="asksql-ext-field">
            <label htmlFor="connAuth">Authorization header (optional)</label>
            <input id="connAuth" type="text" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
          </div>
          {authHeader.trim() && (
            <div className="asksql-ext-warning">
              Like API keys, this is stored unencrypted in this browser profile's local storage. A plaintext http:// URL
              paired with an auth header is rejected outright unless the host is localhost.
            </div>
          )}
        </>
      )}
      <div className="asksql-ext-actions">
        {kind === 'database' && (
          <button className="asksql-ext-btn" disabled={busy} onClick={() => void testDatabase()}>
            Test connection
          </button>
        )}
        <button className="asksql-ext-btn" disabled={busy} onClick={() => void add()}>
          {busy ? 'Working...' : editingId ? 'Save changes' : 'Add connection'}
        </button>
        {editingId && (
          <button className="asksql-ext-btn" onClick={clearForm}>
            Cancel
          </button>
        )}
      </div>
      {status && <p className="asksql-ext-status">{status}</p>}
    </div>
  );
}

function DiagnosticsSection(): JSX.Element {
  const [report, setReport] = useState('');
  const [status, setStatus] = useState('');

  const collect = async () => {
    try {
      const provider = await getProviderSettings();
      const engine = await getEngineSettings();
      const connections = await getConnections();
      const manifest = chrome.runtime.getManifest();
      const sanitized = {
        extensionVersion: manifest.version,
        userAgent: navigator.userAgent,
        provider: { provider: provider.provider, model: provider.model, hasApiKey: Boolean(provider.apiKey) },
        engine,
        connections: connections.map((c) => ({
          name: c.name,
          baseUrl: c.baseUrl,
          hasAuthHeader: Boolean(c.authHeader),
        })),
      };
      setReport(JSON.stringify(sanitized, null, 2));
      setStatus('');
    } catch (err) {
      setStatus(reportError('Collect diagnostics', err));
    }
  };

  return (
    <div className="asksql-ext-section">
      <h2>Diagnostics</h2>
      <button className="asksql-ext-btn" onClick={() => void collect()}>
        Collect diagnostics
      </button>
      {report && <textarea readOnly rows={10} value={report} style={{ width: '100%' }} />}
      {status && <p className="asksql-ext-status">{status}</p>}
    </div>
  );
}

function ResetSection({ onSettingsReset }: { onSettingsReset: () => void }): JSX.Element {
  const [confirming, setConfirming] = useState<'settings' | 'all' | null>(null);
  const [status, setStatus] = useState('');

  const run = async (scope: 'settings' | 'all') => {
    try {
      if (scope === 'settings') {
        await resetSettingsToDefaults();
        onSettingsReset();
        setStatus('Settings are back to their defaults. Your connections were kept.');
      } else {
        await resetAll();
        onSettingsReset();
        setStatus('Everything was cleared. Reload the side panel to see the change.');
      }
      setConfirming(null);
    } catch (err) {
      setStatus(reportError('Reset', err));
    }
  };

  return (
    <div className="asksql-ext-section">
      <h2>Reset</h2>
      {confirming === null && (
        <>
          <div className="asksql-ext-actions">
            <button className="asksql-ext-btn" onClick={() => setConfirming('settings')}>
              Reset settings to defaults
            </button>
            <button className="asksql-ext-btn" onClick={() => setConfirming('all')}>
              Reset everything
            </button>
          </div>
          <p className="asksql-ext-status">
            "Reset settings" puts the AI provider and engine options back to their defaults and keeps every connection.
            "Reset everything" also removes all connections, their stored data, and granted site permissions.
          </p>
        </>
      )}
      {confirming === 'settings' && (
        <>
          <p>Put the AI provider and engine settings back to their defaults? Connections are not touched.</p>
          <div className="asksql-ext-actions">
            <button className="asksql-ext-btn" onClick={() => void run('settings')}>
              Confirm
            </button>
            <button className="asksql-ext-btn" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {confirming === 'all' && (
        <>
          <p>
            This clears every setting and connection, deletes the data behind every data file connection, and revokes
            every granted site permission. This can't be undone.
          </p>
          <div className="asksql-ext-actions">
            <button className="asksql-ext-btn" onClick={() => void run('all')}>
              Confirm reset
            </button>
            <button className="asksql-ext-btn" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
      {status && <p className="asksql-ext-status">{status}</p>}
    </div>
  );
}

function App(): JSX.Element {
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [engine, setEngine] = useState<EngineSettings | null>(null);

  useEffect(() => {
    void getProviderSettings().then(setProvider);
    void getEngineSettings().then(setEngine);
  }, []);

  if (!provider || !engine) return <div className="asksql-ext-options">Loading...</div>;

  return (
    <div className="asksql-ext-options">
      <h1>AskSQL settings</h1>
      <ProviderSection provider={provider} onChange={setProvider} />
      <EngineSection engine={engine} onChange={setEngine} />
      <ConnectionsSection provider={provider} />
      <DiagnosticsSection />
      <ResetSection
        onSettingsReset={() => {
          void getProviderSettings().then(setProvider);
          void getEngineSettings().then(setEngine);
        }}
      />
      <p className="asksql-ext-status">
        <a href="https://rahulmahadik.github.io/AskSQL/privacy.html" target="_blank" rel="noreferrer">
          Privacy policy
        </a>
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
