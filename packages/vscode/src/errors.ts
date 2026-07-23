/**
 * Turns any failure into a sentence the user can act on. AskSqlError and
 * UserFacingError messages are shown verbatim; driver/runtime errors are mapped
 * by code or replaced with a generic line, since they routinely carry hosts and
 * user names. The real text always goes to the log channel.
 */

import { AskSqlError } from '@asksql/core';

/** A command the chat can offer as a one-click fix next to an error. */
export interface SetupAction {
  /** A command id present in WEBVIEW_COMMANDS (chatView.ts). */
  readonly action: string;
  readonly actionLabel: string;
}

/**
 * An error whose message was written for the user and may be shown as-is.
 * Setup failures (no model, no key) carry a `setup` action so the chat can
 * render a button that jumps straight to the fix.
 */
export class UserFacingError extends Error {
  readonly setup?: SetupAction;
  constructor(message: string, setup?: SetupAction) {
    super(message);
    this.name = 'UserFacingError';
    this.setup = setup;
  }
}

/**
 * Default fix-it action for AskSqlError codes that unambiguously mean the AI
 * provider is not set up right. CONFIG_ERROR is excluded: it also covers sqlite
 * file-open failures and connector validation, where a model picker would be wrong.
 */
const SETUP_ACTION_BY_CODE: Readonly<Record<string, SetupAction>> = {
  LLM_AUTH: { action: 'asksql.setApiKey', actionLabel: 'Update API key' },
  LLM_UNREACHABLE: { action: 'asksql.selectProvider', actionLabel: 'Set up provider' },
};

/** The setup command to offer next to this error, if any. */
export function setupAction(err: unknown): SetupAction | undefined {
  if (err instanceof UserFacingError) return err.setup;
  if (AskSqlError.is(err)) return SETUP_ACTION_BY_CODE[err.code];
  return undefined;
}

/**
 * Driver failures worth naming, keyed by the code the driver actually sets.
 * Postgres uses SQLSTATE, MySQL uses ER_* strings, Node uses errno strings.
 */
const BY_CODE: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'The database refused the connection. Check the host and port, and that the server is running.',
  ENOTFOUND: 'That host could not be found. Check the host name.',
  ETIMEDOUT: 'The database did not respond in time. Check the host, port, and your network or VPN.',
  EHOSTUNREACH: 'That host is unreachable. Check your network or VPN.',
  ECONNRESET: 'The database closed the connection unexpectedly.',
  // Postgres SQLSTATE
  '28P01': 'The password was not accepted. Run "AskSQL: Set Database Password".',
  '28000': 'The user name was not accepted. Check the user in your connection settings.',
  '3D000': 'That database does not exist on the server. Check the database name.',
  '42501': 'This user is not allowed to read that. Grant it SELECT, or use a different user.',
  // MySQL
  ER_ACCESS_DENIED_ERROR: 'The user name or password was not accepted. Run "AskSQL: Set Database Password".',
  ER_BAD_DB_ERROR: 'That database does not exist on the server. Check the database name.',
  ER_DBACCESS_DENIED_ERROR: 'This user is not allowed to read that database.',
};

/**
 * The first string `code` on the error or in its `cause` chain (a refused
 * connection carries ECONNREFUSED on the cause, not the top error). Bounded so
 * a self-referential cause cannot loop.
 */
const codeOf = (err: unknown): string | undefined => {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur && typeof cur === 'object'; depth++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'string') return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
};

/** A sentence safe to show in the tree, a notification, or chat. */
export function userMessage(err: unknown): string {
  if (AskSqlError.is(err)) return err.userMessage;
  if (err instanceof UserFacingError) return err.message;
  const mapped = BY_CODE[codeOf(err) ?? ''];
  if (mapped) return mapped;
  return 'Something went wrong. See the AskSQL output channel for details.';
}
