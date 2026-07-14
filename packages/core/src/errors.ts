/**
 * AskSQL error taxonomy.
 *
 * Every failure in the system surfaces as an {@link AskSqlError} with a
 * stable machine `code`, a plain-language actionable `userMessage`
 *, a `retryable` hint for UIs, and a `detail` string that is for
 * logs/console ONLY - `toJSON` deliberately omits it so credentials,
 * hostnames and stack fragments can never leak through an API response
 * (by construction).
 */

export type ErrorCode =
  // LLM / provider family
  | 'LLM_AUTH'
  | 'LLM_BILLING'
  | 'LLM_RATE_LIMIT'
  | 'LLM_TIMEOUT'
  | 'LLM_CONTEXT_OVERFLOW'
  | 'LLM_BAD_OUTPUT'
  | 'LLM_REFUSAL'
  | 'LLM_UNREACHABLE'
  | 'LLM_UNAVAILABLE'
  // Guard
  | 'GUARD_BLOCKED'
  // Database family
  | 'DB_AUTH'
  | 'DB_UNREACHABLE'
  | 'DB_QUERY_ERROR'
  | 'DB_TIMEOUT'
  // Files / WASM
  | 'FILE_PARSE'
  | 'WASM_LOAD'
  // Flow control
  | 'CANCELLED'
  | 'SERVER_AUTHZ'
  | 'INVALID_INPUT'
  | 'CONFIG_ERROR';

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'LLM_RATE_LIMIT',
  'LLM_TIMEOUT',
  'LLM_UNREACHABLE',
  'LLM_UNAVAILABLE',
  'DB_UNREACHABLE',
  'DB_TIMEOUT',
  'WASM_LOAD',
]);

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  LLM_AUTH: 'The AI provider rejected the configured key. Update it in your AskSQL configuration.',
  LLM_BILLING:
    'The AI provider account is out of credits or over its usage quota. Add credits or check the plan and billing settings.',
  LLM_RATE_LIMIT: 'The AI provider is busy right now. It was retried automatically - try again shortly.',
  LLM_TIMEOUT: 'The AI took too long to answer. Local models may still be loading - retry.',
  LLM_CONTEXT_OVERFLOW: 'The schema is too large for this model. Narrow the question or select fewer tables.',
  LLM_BAD_OUTPUT: "Couldn't produce valid SQL for this question. Try rephrasing it.",
  LLM_REFUSAL: 'The AI model declined to answer this question.',
  LLM_UNREACHABLE: "Can't reach the AI endpoint. Check that it is running and the URL is correct.",
  LLM_UNAVAILABLE: 'The AI provider had a temporary problem. Try again.',
  GUARD_BLOCKED: 'Blocked for safety: this statement is not allowed in read-only mode.',
  DB_AUTH: 'The database rejected the connection credentials (server configuration).',
  DB_UNREACHABLE: "Can't reach the database right now.",
  DB_QUERY_ERROR: 'The query failed to run.',
  DB_TIMEOUT: 'The query took too long and was stopped. Add filters or narrow the date range.',
  FILE_PARSE: "Couldn't read the file. Try re-saving it as UTF-8 CSV.",
  WASM_LOAD: 'The local analysis engine failed to load. Check your network and browser settings.',
  CANCELLED: 'Cancelled.',
  SERVER_AUTHZ: "You don't have access to this connection.",
  INVALID_INPUT: 'Please enter a question.',
  CONFIG_ERROR: 'AskSQL is misconfigured. Check the server logs for details.',
};

export interface AskSqlErrorOptions {
  /** Override the default plain-language message. Keep it actionable. */
  userMessage?: string;
  /** Technical detail for logs/console only. NEVER shown to end users. */
  detail?: string;
  cause?: unknown;
  retryable?: boolean;
}

export class AskSqlError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(code: ErrorCode, opts: AskSqlErrorOptions = {}) {
    const userMessage = opts.userMessage ?? DEFAULT_MESSAGES[code];
    super(opts.detail ? `${code}: ${opts.detail}` : `${code}: ${userMessage}`);
    this.name = 'AskSqlError';
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.detail = opts.detail;
    if (opts.cause !== undefined) {
      // Preserve the chain for logging without serializing it anywhere.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  static is(err: unknown): err is AskSqlError {
    return err instanceof AskSqlError;
  }

  /** Coerce any thrown value into an AskSqlError without losing the chain. */
  static from(err: unknown, fallback: ErrorCode): AskSqlError {
    if (AskSqlError.is(err)) return err;
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return new AskSqlError(fallback, { detail, cause: err });
  }

  /**
   * Wire-safe shape: code + userMessage + retryable ONLY. `detail`, `stack`
   * and `cause` are intentionally excluded.
   */
  toJSON(): { code: ErrorCode; userMessage: string; retryable: boolean } {
    return { code: this.code, userMessage: this.userMessage, retryable: this.retryable };
  }
}
