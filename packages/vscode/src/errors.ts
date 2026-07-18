/**
 * Turning any failure into a sentence the user can act on.
 *
 * Three kinds of error reach the UI:
 *  - AskSqlError, which already carries a written `userMessage`,
 *  - UserFacingError, which we wrote ourselves and can show verbatim,
 *  - anything else: a driver or runtime error. Those are NOT shown. `ECONNREFUSED
 *    127.0.0.1:5432` tells a developer plenty and a user nothing, and driver
 *    errors routinely carry the host and user name.
 *
 * The last kind is mapped to a plain sentence by its code where we recognise it,
 * and to a generic line otherwise. The real text always goes to the log channel.
 */

import { AskSqlError } from '@asksql/core';

/** A command the chat can offer as a one-click fix next to an error. */
export interface SetupAction {
  /** A command id present in WEBVIEW_COMMANDS (chatView.ts). */
  readonly action: string;
  readonly actionLabel: string;
}

/**
 * An error whose message was written FOR the user and may be shown as-is.
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
 * Default fix-it action for the AskSqlError codes that mean "the AI provider is
 * not set up right", so a chat failure offers the relevant setup command
 * instead of a dead-end message. UserFacingError carries its own action; this
 * fills in for the typed engine errors.
 */
// Only codes that UNAMBIGUOUSLY mean "the AI provider is not set up right".
// CONFIG_ERROR is deliberately excluded: it is also the code for a sqlite
// file-open failure, guard misconfig and connector validation, so mapping it to
// a model picker would show "Choose model" on a broken database path.
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
 * The first string `code` on the error or anywhere in its `cause` chain. A
 * refused connection surfaces as a fetch error whose `cause` (not the top
 * error) carries `ECONNREFUSED`, so without walking the chain a
 * "start the server" failure falls through to the generic line. Bounded so a
 * self-referential cause cannot loop.
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
