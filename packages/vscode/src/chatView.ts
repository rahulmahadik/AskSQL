/**
 * The AskSQL panel - a dedicated view, not a guest in someone else's chat.
 *
 * The Chat Participant API was the obvious "native" choice and it was the wrong
 * one: a participant can ONLY live inside VS Code's shared chat panel, which
 * means an `@asksql` mention, VS Code's own model dropdown listing Copilot and
 * Claude, and settings that belong to that panel rather than to us. None of that
 * is restylable - the panel is VS Code's. VS Code exposes no API for a native
 * custom chat surface, so a WebviewView is the only way to own the experience.
 *
 * "Webview" does not mean "web page in a tab". Every colour, font, radius, and
 * focus ring below comes from VS Code's own theme variables, so this matches the
 * user's theme (any theme, light or dark) without us shipping a palette.
 *
 * Trust boundary: the webview renders, and nothing else. It never sees a
 * credential, never touches a database, and never builds SQL. It posts a
 * question to the extension host and receives structured results back. All
 * values are written with textContent in media/chat.js, never innerHTML.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { AskSqlError, type AskSqlEngine, type ResultSet, type SchemaCatalog, type TableInfo } from '@asksql/core';
import { type ConnectionConfig, type EngineManager, connectionConfigs } from './engine.js';
import { providerModels } from './models.js';
import { LM_LIST_TIMEOUT_MS, MODEL_LOOKUP_TIMEOUT_MS } from './constants.js';
import { log } from './log.js';
import { userMessage, UserFacingError } from './errors.js';

/** Rows rendered inline before we stop and point at the editor instead. */
const INLINE_ROWS = 50;

/** Which model answers. Chosen in OUR picker, not VS Code's. */
type ModelChoice = { readonly kind: 'vscode'; readonly id: string } | { readonly kind: 'configured' };

const STAGE_LABEL: Record<string, string> = {
  catalog: 'Reading schema',
  prune: 'Finding relevant tables',
  prompt: 'Building the prompt',
  llm: 'Writing SQL',
  extract: 'Reading the reply',
  repair: 'Correcting the SQL',
  guard: 'Checking safety',
  execute: 'Running the query',
  done: 'Done',
};

interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

/**
 * A cell for the webview: primitives only, so nothing exotic crosses the
 * boundary. NULL becomes `null` (JS null) and an empty string stays `''`, so the
 * grid can tell "no value" from "the empty string" instead of showing both as null.
 */
const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

/** Where the model choice is remembered across reloads. */
const MODEL_CHOICE_KEY = 'asksql.modelChoice';

/** Posted when a result's buttons outlive the bounded result store. */
const RESULT_GONE = 'This result is no longer kept in memory - run the query again.';

/**
 * The only commands the webview may ask the host to run. The webview is a trust
 * boundary - it renders untrusted result data - so it must not invoke arbitrary
 * VS Code commands. Deny-by-default: this is exactly the set of commands our error
 * banners attach as an action button today. Add a command here only when a new
 * banner offers it.
 */
const WEBVIEW_COMMANDS: ReadonlySet<string> = new Set(['asksql.addConnection']);

/** "Describe this table" questions answered from the catalog, not the model. */
const DESCRIBE_PATTERNS: readonly RegExp[] = [
  /^\s*(?:describe|desc)\s+(?:the\s+)?(?:table\s+|view\s+)?["'`]?([\w.]+)["'`]?(?:\s+(?:table|view))?\s*[?.]?\s*$/i,
  /^\s*(?:what|which)\s+columns?\s+(?:are\s+)?(?:in|on|of|does)\s+(?:the\s+)?["'`]?([\w.]+)["'`]?/i,
  /^\s*(?:show|list)\s+(?:me\s+)?(?:the\s+)?(?:columns|structure|schema)\s+(?:of|for|in)\s+["'`]?([\w.]+)["'`]?/i,
  /^\s*structure\s+of\s+(?:the\s+)?["'`]?([\w.]+)["'`]?/i,
];

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  /**
   * Restored from globalState: a picker that forgets on every reload is not a
   * picker. Machine-level, like the model setting itself - the model you can run
   * is a property of your machine, not of the project you have open.
   */
  private choice: ModelChoice;
  /** The in-flight turn, so Stop actually stops it. */
  private running: AbortController | undefined;
  /** Resolver for an inline "Run this query?" approval, so it is not a blocking modal. */
  private pendingApproval: { readonly id: string; readonly resolve: (ok: boolean) => void } | undefined;
  /**
   * Per-result store, keyed by a turn-local id. Export CSV then exports the rows
   * of the turn its button belongs to, not whatever ran most recently. Bounded so
   * a long session does not pin every result set in memory.
   */
  private readonly results = new Map<string, ResultSet>();
  private resultSeq = 0;
  /**
   * Prior turns this session, passed to the engine as context so a follow-up
   * ("now only for the west region") resolves against the previous query instead
   * of being answered in isolation.
   */
  private readonly history: { question: string; sql: string; connectionId: string }[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly engines: EngineManager,
  ) {
    const saved = ctx.globalState.get<string>(MODEL_CHOICE_KEY);
    this.choice = saved?.startsWith('vscode:')
      ? { kind: 'vscode', id: saved.slice('vscode:'.length) }
      : { kind: 'configured' };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // Only our own media directory. Nothing else is loadable.
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };

    // Listener BEFORE html, always. Assigning html loads the page, which posts
    // `ready` immediately; registering afterwards races that message and loses
    // it, so the state reply never fires and the Database and Model pickers stay
    // empty forever. With no connection selected the panel then silently used
    // whichever connection came first.
    view.webview.onDidReceiveMessage((m: { type: string; [k: string]: unknown }) => {
      if (m.type === 'ready') void this.pushState();
      if (m.type === 'ask') void this.ask(String(m.text ?? ''), m.connectionId ? String(m.connectionId) : undefined);
      if (m.type === 'stop') {
        // Only the first Stop of a live turn does anything; extra presses must not
        // append another "Cancelled." note or abort nothing.
        if (this.running && !this.running.signal.aborted) {
          this.running.abort();
          this.post({ type: 'cancelled' });
        }
      }
      if (m.type === 'approve') {
        const pending = this.pendingApproval;
        // Only the id this turn is awaiting may settle it; a stale turn's button is ignored.
        if (pending && String(m.approvalId ?? '') === pending.id) {
          this.pendingApproval = undefined;
          pending.resolve(Boolean(m.ok));
        }
      }
      // The SQL travels WITH the click, so an old turn's button opens that turn's
      // query, not whatever ran most recently.
      if (m.type === 'openSql') void vscode.commands.executeCommand('asksql.openSqlInEditor', String(m.sql ?? ''));
      if (m.type === 'exportCsv') {
        const res = this.results.get(String(m.resultId ?? ''));
        if (res) void vscode.commands.executeCommand('asksql.exportCsv', res);
        else this.post({ type: 'error', message: RESULT_GONE });
      }
      if (m.type === 'copy') {
        const res = this.results.get(String(m.resultId ?? ''));
        if (res) void this.copyResult(res, String(m.resultId ?? ''));
        else this.post({ type: 'error', message: RESULT_GONE });
      }
      if (m.type === 'openResult') {
        const res = this.results.get(String(m.resultId ?? ''));
        if (res) void this.openResultInEditor(res);
        else this.post({ type: 'error', message: RESULT_GONE });
      }
      if (m.type === 'plan') void this.plan(String(m.sql ?? ''), m.connectionId ? String(m.connectionId) : undefined, m.planId ? String(m.planId) : undefined);
      if (m.type === 'command') {
        const id = String(m.id ?? '');
        if (WEBVIEW_COMMANDS.has(id)) void vscode.commands.executeCommand(id);
        else log.warn(`ignored a non-allowlisted command from the webview: ${id}`);
      }
    });

    view.webview.html = this.html(view.webview);

    // Connections or the provider can change while we are hidden.
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.pushState();
    });

    // A disposed view must be forgotten, or post() targets a dead webview and
    // every later refresh is silently swallowed.
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        // A turn awaiting inline approval would otherwise wait forever.
        this.running?.abort();
      }
    });
  }

  focus(): void {
    void vscode.commands.executeCommand('asksql.chat.focus');
  }

  clear(): void {
    // End any live turn first, or a pending approval would wait forever.
    this.running?.abort();
    // Clearing the panel also clears the context, or the next question would
    // silently be a follow-up to a conversation the user can no longer see.
    this.history.length = 0;
    this.results.clear();
    this.post({ type: 'clear' });
  }

  /** Settings changed elsewhere: refresh the header. */
  refresh(): void {
    void this.pushState();
  }

  private post(msg: Record<string, unknown>): void {
    try {
      void this.view?.webview.postMessage(msg);
    } catch (err) {
      // The view can be disposed between the check above and the post; a dead
      // webview is not an error worth surfacing.
      log.info('post to webview skipped (view gone)', String(err));
    }
  }

  /**
   * The configured-provider option, always available and built synchronously.
   * This is what lets the pickers render instantly - it needs no network and no
   * language-model activation.
   */
  private configuredOption(): ModelOption {
    const cfg = vscode.workspace.getConfiguration('asksql');
    const provider = cfg.get<string>('provider') ?? 'ollama';
    const model = cfg.get<string>('model')?.trim();
    return {
      id: 'configured',
      label: model ? `${provider}: ${model}` : `${provider} (no model selected)`,
      detail: 'Your own provider',
    };
  }

  /** VS Code chat models, time-bounded so a stalled provider cannot hang the panel. */
  private async vscodeModelOptions(): Promise<ModelOption[]> {
    try {
      const models = await Promise.race([
        vscode.lm.selectChatModels(),
        new Promise<vscode.LanguageModelChat[]>((resolve) => setTimeout(() => resolve([]), LM_LIST_TIMEOUT_MS)),
      ]);
      return models.map((m) => ({ id: `vscode:${m.id}`, label: m.name, detail: m.vendor }));
    } catch (err) {
      // No chat models available (no Copilot, no consent). Not an error: the
      // user's own provider is the point of this product.
      log.info('no VS Code chat models available', String(err));
      return [];
    }
  }

  private async setModel(id: string): Promise<void> {
    this.choice = id.startsWith('vscode:') ? { kind: 'vscode', id: id.slice('vscode:'.length) } : { kind: 'configured' };
    await this.ctx.globalState.update(MODEL_CHOICE_KEY, id);
    this.pushState();
  }

  /**
   * The wizard defaults the name to the engine ("MySQL / MariaDB"), so two
   * connections to the same engine look identical. Name the database too.
   */
  private connLabel(c: ConnectionConfig): string {
    const target = (c.engine === 'sqlite' ? ((c.file ?? '').split(/[\\/]/).pop() ?? '') : (c.database ?? '')).trim();
    return target ? `${c.name} - ${target}` : c.name;
  }

  /**
   * Disambiguated label per connection id, used by BOTH the dropdown and the
   * per-turn attribution so they never disagree. Two connections that share a
   * "name - database" label get a host:port (or SQLite parent folder) discriminator.
   */
  private connLabels(): Map<string, string> {
    const conns = connectionConfigs();
    const base = new Map<string, string>();
    for (const c of conns) base.set(c.id, this.connLabel(c));
    // Discriminators tried in order until every label is unique: host:port (or the
    // SQLite parent folder), then the user, then the connection id as a last resort.
    const extras = (c: (typeof conns)[number]): string[] => {
      const hostPort = [c.host, c.port].filter((p) => p !== undefined && String(p).trim() !== '').join(':');
      const folder = (c.file ?? '').split(/[\\/]/).slice(-2, -1)[0] ?? '';
      return [c.engine === 'sqlite' ? folder : hostPort, c.user ?? '', c.id].filter(Boolean);
    };
    const labels = new Map<string, string>(base);
    for (let depth = 1; depth <= 3; depth++) {
      const counts = new Map<string, number>();
      for (const c of conns) {
        const l = labels.get(c.id) ?? '';
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let collided = false;
      for (const c of conns) {
        if ((counts.get(labels.get(c.id) ?? '') ?? 0) < 2) continue;
        collided = true;
        const parts = extras(c).slice(0, depth);
        if (parts.length) labels.set(c.id, `${base.get(c.id) ?? ''} (${parts.join(', ')})`);
      }
      if (!collided) break;
    }
    return labels;
  }

  /**
   * The panel needs only the databases. The model is chosen in a QuickPick, so this
   * never waits on the language-model lookup - a stalled provider cannot empty it.
   */
  private pushState(): void {
    const labels = this.connLabels();
    const connections = connectionConfigs().map((c) => {
      const hostPort = [c.host, c.port].filter((p) => p !== undefined && String(p).trim() !== '').join(':');
      const endpoint =
        c.engine === 'sqlite'
          ? (c.file ?? '')
          : `${c.user ? `${c.user}@` : ''}${[hostPort, c.database].filter(Boolean).join('/')}`;
      return {
        id: c.id,
        name: c.name,
        label: labels.get(c.id) ?? c.name,
        title: `${c.engine} ${endpoint} (${c.scope} settings)`.replace(/\s+/g, ' ').trim(),
      };
    });
    this.post({ type: 'state', connections });
  }

  /**
   * Choose which model answers: a VS Code chat model, or your configured provider.
   * A one-time choice, so it is a QuickPick rather than a permanent header control.
   */
  async pickModel(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('asksql');
    const provider = cfg.get<string>('provider') ?? 'ollama';
    const currentModel = cfg.get<string>('model')?.trim();
    // The provider's OWN models (Ollama / OpenAI-compatible), listed so the picker
    // shows every model, not just a single "configured" summary.
    let provModels: string[] = [];
    try {
      provModels = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `AskSQL: listing ${provider} models...` },
        () => providerModels(this.ctx.secrets, MODEL_LOOKUP_TIMEOUT_MS),
      );
    } catch (err) {
      log.info('could not list provider models', String(err));
    }
    const vscodeModels = await this.vscodeModelOptions();

    type Pick = { readonly kind: 'provider'; readonly model: string } | { readonly kind: 'vscode'; readonly id: string } | { readonly kind: 'change' };
    const items: (vscode.QuickPickItem & { pick: Pick })[] = [];
    for (const model of provModels) {
      const cur = this.choice.kind === 'configured' && model === currentModel;
      items.push({ label: model, description: `${provider}${cur ? ' - current' : ''}`, pick: { kind: 'provider', model } });
    }
    if (provModels.length === 0) {
      const c = this.configuredOption();
      const cur = this.choice.kind === 'configured';
      items.push({ label: c.label, description: `${c.detail}${cur ? ' - current' : ''}`, pick: { kind: 'change' } });
    }
    for (const m of vscodeModels) {
      const cur = this.choice.kind === 'vscode' && `vscode:${this.choice.id}` === m.id;
      items.push({ label: m.label, description: `${m.detail}${cur ? ' - current' : ''}`, pick: { kind: 'vscode', id: m.id } });
    }
    items.push({ label: '$(gear) Change provider or endpoint...', pick: { kind: 'change' } });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Which model should answer?', ignoreFocusOut: true });
    if (!picked) return;
    const p = picked.pick;
    if (p.kind === 'change') {
      await vscode.commands.executeCommand('asksql.selectProvider');
      return;
    }
    if (p.kind === 'vscode') {
      await this.setModel(p.id);
      void vscode.window.showInformationMessage(`AskSQL: ${picked.label} will answer.`);
      return;
    }
    // A model from the configured provider: save it and answer via the provider.
    await cfg.update('model', p.model, vscode.ConfigurationTarget.Global);
    await this.setModel('configured');
    void vscode.window.showInformationMessage(`AskSQL: ${provider} ${p.model} will answer.`);
  }

  private async engineFor(): Promise<AskSqlEngine> {
    const choice = this.choice;
    if (choice.kind === 'configured') return this.engines.forConfiguredModel();
    // Bounded: an unbounded selectChatModels() on the ask path could stall forever
    // and leave the panel locked (turnEnd never fires). Same guard as the picker.
    const models = await Promise.race([
      vscode.lm.selectChatModels(),
      new Promise<vscode.LanguageModelChat[]>((resolve) => setTimeout(() => resolve([]), LM_LIST_TIMEOUT_MS)),
    ]);
    const lm = models.find((m) => m.id === choice.id);
    if (!lm) {
      throw new UserFacingError(
        'That model is no longer available. Choose another with "AskSQL: Choose Answering Model" (the sparkle icon in this panel\'s title bar).',
      );
    }
    return this.engines.forChatModel(lm);
  }

  /**
   * Describe a table straight from the catalog.
   *
   * "describe the customers table" is a question about STRUCTURE, and we already
   * hold the structure. Handing it to a model produced `SELECT * FROM customers`
   * - the rows, not the shape - because the model's job is data questions. This
   * answers instantly, exactly, and without spending a token.
   *
   * Only fires when the named thing is really a table in this connection, so a
   * question like "describe the trend in orders" still goes to the model.
   */
  private describeFromCatalog(question: string, cat: SchemaCatalog): { table: TableInfo } | { missing: string } | undefined {
    let m: RegExpExecArray | null = null;
    for (const re of DESCRIBE_PATTERNS) {
      m = re.exec(question);
      if (m) break;
    }
    if (!m) return undefined;
    const wanted = (m[1] ?? '').toLowerCase();
    const bare = wanted.includes('.') ? wanted.slice(wanted.lastIndexOf('.') + 1) : wanted;
    const table = cat.tables.find((t) => {
      const full = `${t.schema ? `${t.schema}.` : ''}${t.name}`.toLowerCase();
      return full === wanted || t.name.toLowerCase() === bare;
    });
    // The question named a table; if it is not in THIS connection, say which
    // connection and what tables it does have, rather than guessing with the model.
    return table ? { table } : { missing: bare };
  }

  /** The query plan for the last statement, from the database. */
  private async plan(sql: string, connectionId?: string, planId?: string): Promise<void> {
    if (!sql) return;
    const id = connectionId || connectionConfigs()[0]?.id;
    if (!id) return;
    // planId routes the plan's progress/result/error to the turn whose button was
    // clicked, not the globally-current turn.
    this.post({ type: 'progress', label: 'Asking the database for its plan', planId });
    try {
      const res = await this.engines.explain(id, sql);
      this.post({
        type: 'plan',
        planId,
        columns: res.columns.map((c) => c.name),
        rows: res.rows.slice(0, INLINE_ROWS).map((r) => r.map(cell)),
        rowCount: res.rowCount,
        shown: Math.min(res.rowCount, INLINE_ROWS),
      });
    } catch (err) {
      log.error('plan failed', err);
      this.post({ type: 'error', message: userMessage(err), planId });
    }
  }

  private async ask(text: string, connectionId?: string): Promise<void> {
    const question = text.trim();
    if (!question) return;
    const conns = connectionConfigs();
    const conn = conns.find((c) => c.id === connectionId) ?? conns[0];
    // Open the turn FIRST, so even the no-connection case renders the question
    // and an actionable error instead of the question silently vanishing.
    this.post({ type: 'turnStart', question, connection: conn ? (this.connLabels().get(conn.id) ?? conn.name) : '' });
    if (conns.length === 0) {
      this.post({ type: 'error', message: 'Connect a database first.', action: 'asksql.addConnection', actionLabel: 'Add Connection' });
      this.post({ type: 'turnEnd' });
      return;
    }
    this.running?.abort();
    const ac = new AbortController();
    this.running = ac;

    try {
      // Structure questions are answered from the catalog, not the model. Only
      // fetch the catalog when the question looks like one, so an ordinary question
      // does not pay for an introspect the engine will do anyway.
      if (conn && DESCRIBE_PATTERNS.some((re) => re.test(question))) {
        this.post({ type: 'progress', label: 'Reading schema' });
        const cat = await this.engines.catalogFor(conn.id);
        if (ac.signal.aborted) return;
        const hit = this.describeFromCatalog(question, cat);
        if (hit && 'table' in hit) {
          const t = hit.table;
          this.post({
            type: 'result',
            columns: ['column', 'type', 'nullable', 'key'],
            rows: t.columns.map((c) => [
              c.name,
              c.dbType,
              c.nullable ? 'yes' : 'no',
              [t.primaryKey.includes(c.name) ? 'PK' : '', t.foreignKeys.find((f) => f.columns.includes(c.name)) ? 'FK' : '']
                .filter(Boolean)
                .join(' '),
            ]),
            rowCount: t.columns.length,
            shown: t.columns.length,
            durationMs: 0,
            truncated: false,
            note: `${t.schema ? `${t.schema}.` : ''}${t.name} (${t.kind.replace('_', ' ')}), read from the schema - no query was run.`,
          });
          return;
        }
        if (hit && 'missing' in hit) {
          const label = this.connLabels().get(conn.id) ?? conn.name;
          const names = cat.tables.map((t) => t.name);
          const list = names.length
            ? ` Tables in this connection: ${names.slice(0, 50).join(', ')}${names.length > 50 ? ', ...' : ''}.`
            : ' This connection has no tables the current user can read.';
          this.post({ type: 'error', message: `No table named "${hit.missing}" in ${label}.${list}` });
          return;
        }
      }

      const engine = await this.engineFor();
      const answer = await engine.ask(question, {
        // The resolved connection, matching the turn's displayed attribution - not
        // the raw webview id, which can be stale before its state refresh arrives.
        connectionId: conn?.id,
        // Follow-up context, but ONLY for the connection being asked now - a prior
        // query against another database references tables this one does not have.
        context: this.history.filter((h) => h.connectionId === (conn?.id ?? '')).slice(-6).map((h) => ({ question: h.question, sql: h.sql })),
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === 'stage') this.post({ type: 'progress', label: STAGE_LABEL[e.stage] ?? e.stage });
        },
      });
      if (ac.signal.aborted) return;

      // Remember this turn as context for the next follow-up (bounded), tagged with
      // its connection so a later switch does not carry the wrong schema's queries.
      this.history.push({ question, sql: answer.sql, connectionId: conn?.id ?? '' });
      if (this.history.length > 20) this.history.shift();

      // Approval requires reading the query, so that setting forces SQL first.
      const cfg = vscode.workspace.getConfiguration('asksql');
      const approval = cfg.get<boolean>('requireApproval') === true;
      // Turn-local id: only the buttons carrying it back may settle THIS approval.
      const approvalId = approval ? `a${++this.resultSeq}` : undefined;
      this.post({
        type: 'sql',
        sql: answer.sql,
        // The turn's connection, so Explain plan targets it instead of the live dropdown.
        connectionId: conn?.id,
        explanation: answer.explanation ?? '',
        autoLimited: answer.guard.autoLimited,
        placement: approval ? 'before' : (cfg.get<string>('sqlDisplay') ?? 'after'),
        needsApproval: approval,
        ...(approvalId ? { approvalId } : {}),
      });

      if (approvalId) {
        // Inline approval: Run / Don't run render under the SQL in the panel,
        // instead of a blocking native modal with the query crammed into it.
        const ok = await new Promise<boolean>((resolve) => {
          this.pendingApproval = { id: approvalId, resolve };
          if (ac.signal.aborted) resolve(false);
          else ac.signal.addEventListener('abort', () => resolve(false), { once: true });
        });
        this.pendingApproval = undefined;
        if (!ok) {
          // Abort-resolved: Stop already noted it, or a newer turn owns the log.
          if (!ac.signal.aborted) this.post({ type: 'notRun' });
          return;
        }
      }
      if (ac.signal.aborted) return;

      // No manual tick here: the engine emits its own `execute` stage, and
      // posting one too showed the user "Running the query" twice.
      const res = await answer.run({ signal: ac.signal });
      if (ac.signal.aborted) return;

      const resultId = `r${++this.resultSeq}`;
      this.storeResult(resultId, res);
      this.post({
        type: 'result',
        resultId,
        columns: res.columns.map((c) => c.name),
        rows: res.rows.slice(0, INLINE_ROWS).map((r) => r.map(cell)),
        rowCount: res.rowCount,
        shown: Math.min(res.rowCount, INLINE_ROWS),
        durationMs: res.durationMs,
        truncated: res.truncated,
      });
    } catch (err) {
      if (ac.signal.aborted) return;
      if (AskSqlError.is(err)) {
        const suggested = (err as { suggestedSql?: string }).suggestedSql;
        this.post({
          type: 'error',
          message: err.userMessage,
          guard: err.code === 'GUARD_BLOCKED',
          suggestedSql: suggested ?? '',
        });
        return;
      }
      log.error('chat turn failed', err);
      this.post({ type: 'error', message: userMessage(err) });
    } finally {
      // Only the CURRENT turn unlocks the UI. A superseded turn (aborted because a
      // new question started) must not post turnEnd - that would unlock the panel
      // while the newer turn is still running.
      if (this.running === ac) {
        this.running = undefined;
        this.post({ type: 'turnEnd' });
      }
    }
  }

  /** Keep a turn's result, bounded but above the webview's turn cap so a visible turn's result is never evicted. */
  private storeResult(id: string, res: ResultSet): void {
    this.results.set(id, res);
    while (this.results.size > 80) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
  }

  /**
   * Open the WHOLE result in an editor as JSON. The panel shows only the first rows.
   *
   * JSON carries the result without altering it: NULL stays `null`, an empty string
   * stays `""`, and a literal "NULL" stays a quoted string - none of which a text
   * table can distinguish. Rows stay arrays so duplicate column names (routine in a
   * join) are not collapsed, and nothing needs padding or truncating.
   */
  private async openResultInEditor(res: ResultSet): Promise<void> {
    // JSON has no BigInt, NaN, or Infinity - stringify them, or a non-finite float exports as null.
    const replacer = (_k: string, v: unknown): unknown =>
      typeof v === 'bigint' ? v.toString() : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v;
    const payload = {
      rowCount: res.rowCount,
      durationMs: res.durationMs,
      truncated: res.truncated,
      columns: res.columns.map((c) => c.name),
      rows: res.rows,
    };
    const doc = await vscode.workspace.openTextDocument({
      content: JSON.stringify(payload, replacer, 2),
      language: 'json',
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Copy the result to the clipboard as TSV (header row + all rows), for pasting into a sheet. */
  private async copyResult(res: ResultSet, resultId: string): Promise<void> {
    const val = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      // Excel-style quoting: a tab or newline inside a cell must not break the grid.
      return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const tsv = [res.columns.map((c) => val(c.name)).join('\t'), ...res.rows.map((r) => r.map(val).join('\t'))].join(
      '\n',
    );
    try {
      await vscode.env.clipboard.writeText(tsv);
      // The webview flashes success only on this ack, never optimistically.
      this.post({ type: 'copied', resultId });
    } catch (err) {
      log.error('copy to clipboard failed', err);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (f: string): vscode.Uri => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    // Locked down: no remote anything, scripts only by nonce.
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('chat.css')}">
<title>AskSQL</title>
</head>
<body>
  <header class="bar">
    <label class="field">
      <span class="lbl">Database</span>
      <select id="conn" aria-label="Database"></select>
    </label>
  </header>
  <main id="log" role="log" aria-live="polite"></main>
  <div id="empty" class="empty">
    <p class="empty-title">Ask your database in plain English.</p>
    <p class="empty-sub">The SQL is always shown before anything runs, and only read-only queries are allowed.</p>
    <ul class="samples">
      <li><button class="sample" type="button">What tables are in this database?</button></li>
      <li><button class="sample" type="button">How many rows are in each table?</button></li>
    </ul>
  </div>
  <footer class="composer">
    <textarea id="q" rows="1" placeholder="Ask a question..." aria-label="Your question"></textarea>
    <button id="send" type="button">Ask</button>
  </footer>
  <script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
  }
}
