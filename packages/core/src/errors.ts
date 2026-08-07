/**
 * AskSQL error taxonomy.
 *
 * Every failure surfaces as an {@link AskSqlError} with a stable machine `code`, an actionable
 * `userMessage`, a `retryable` hint for UIs, and a `detail` string that `toJSON` omits.
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
  /** The server answered; it has no database or schema by that name. Not retryable, unlike unreachable. */
  | 'DB_NOT_FOUND'
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
  LLM_RATE_LIMIT: 'The AI provider is rate-limiting requests right now. Wait a moment and try again.',
  LLM_TIMEOUT: 'The AI took too long to answer. Local models may still be loading - retry.',
  LLM_CONTEXT_OVERFLOW:
    'The prompt is larger than this model accepts. Use a model with a bigger context, ask about fewer tables, or start a new conversation.',
  LLM_BAD_OUTPUT: "Couldn't produce valid SQL for this question. Try rephrasing it.",
  LLM_REFUSAL: 'The AI model declined to answer this question.',
  LLM_UNREACHABLE: "Can't reach the AI endpoint. Check that it is running and the URL is correct.",
  LLM_UNAVAILABLE: 'The AI provider had a temporary problem. Try again.',
  GUARD_BLOCKED: 'Blocked for safety: this statement is not allowed in read-only mode.',
  DB_AUTH: 'The database refused those credentials. Check the username and password.',
  DB_UNREACHABLE: "Can't reach the database. Check that it is running and the host and port are right.",
  DB_NOT_FOUND: 'The server answered, but there is no database with that name on it. Check the database name.',
  DB_QUERY_ERROR: 'The query failed to run.',
  DB_TIMEOUT: 'The query took too long and was stopped. Add filters or narrow the date range.',
  FILE_PARSE: "Couldn't read that file. Check that it is not corrupt and is in the format its extension claims.",
  WASM_LOAD: 'The local analysis engine failed to load. Check your network and browser settings.',
  CANCELLED: 'Cancelled.',
  SERVER_AUTHZ: "You don't have access to this connection.",
  INVALID_INPUT: 'Please enter a question.',
  CONFIG_ERROR: 'AskSQL is misconfigured. Check its connection and model settings.',
};

export interface AskSqlErrorOptions {
  /** Override the default plain-language message. Keep it actionable. */
  userMessage?: string;
  /** Technical detail for logs/console only. Never shown to end users. */
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

  /** Wire-safe shape: code + userMessage + retryable only. */
  toJSON(): { code: ErrorCode; userMessage: string; retryable: boolean } {
    return { code: this.code, userMessage: this.userMessage, retryable: this.retryable };
  }
}
