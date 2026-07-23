/**
 * Extension-wide constants. No model ids here: models are discovered from the
 * endpoint the user configured, never baked into a list.
 */

/** Mirrors the unexported default in @asksql/core's providers.ts. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

/** Default ports, used only to pre-fill the add-connection prompts. */
export const DEFAULT_PORT: Readonly<Record<string, number>> = {
  postgres: 5432,
  mysql: 3306,
  oracle: 1521,
};

/** Ceiling on opening a connection and reading its schema; `pg` alone would wait forever. */
export const CONNECT_TIMEOUT_MS = 15_000;

/** Ceiling on a "Select Model" lookup; Node's fetch has no default timeout. */
export const MODEL_LOOKUP_TIMEOUT_MS = 10_000;

/** Ceiling on listing VS Code chat models; onDidChangeChatModels still adds late arrivals. */
export const LM_LIST_TIMEOUT_MS = 8_000;

/** Ceiling on the "Test AI Provider" probe; generous because a local model may load from disk. */
export const PROVIDER_TEST_TIMEOUT_MS = 60_000;
