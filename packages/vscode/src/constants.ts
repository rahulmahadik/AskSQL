/**
 * Single home for the extension's constants.
 *
 * `OLLAMA_DEFAULT_BASE_URL` mirrors the value in @asksql/core's providers.ts,
 * which does not export it. It is duplicated here deliberately rather than in
 * several files, so there is exactly one place to change. If core ever exports
 * it, import it from there and delete this.
 *
 * Note there are no model ids here on purpose: model catalogues change weekly,
 * and users bring their own LLM. Models are discovered from the endpoint the
 * user configured, never guessed from a list we baked in.
 */

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/** Default ports, used only to pre-fill the add-connection prompts. */
export const DEFAULT_PORT: Readonly<Record<string, number>> = {
  postgres: 5432,
  mysql: 3306,
};

/**
 * Ceiling on opening a connection and reading its schema.
 *
 * `pg` defaults connectionTimeoutMillis to 0, which means wait forever: a host
 * that silently drops packets (VPN down, wrong port, firewall) would leave the
 * tree spinning with no error and no way out. mysql2 already bounds this at 10s;
 * this makes every engine behave the same.
 */
export const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Ceiling on a "Select Model" lookup. Node's fetch has no default timeout, so
 * without this an unreachable endpoint hangs the picker indefinitely.
 */
export const MODEL_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Ceiling on listing VS Code chat models for the panel's Model picker. The panel
 * already renders the configured provider instantly, so this only bounds how long
 * we wait for Copilot-style models before giving up; onDidChangeChatModels still
 * adds them later if they arrive after this.
 */
export const LM_LIST_TIMEOUT_MS = 8_000;

/**
 * Ceiling on the "Test AI Provider" probe. A local model that has to load from
 * disk on first call is genuinely slow, so this is generous - it exists to stop
 * a dead endpoint hanging the test, not to judge speed.
 */
export const PROVIDER_TEST_TIMEOUT_MS = 60_000;
