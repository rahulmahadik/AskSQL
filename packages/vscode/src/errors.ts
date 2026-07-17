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

/** An error whose message was written FOR the user and may be shown as-is. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
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

const codeOf = (err: unknown): string | undefined => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
};

/** A sentence safe to show in the tree, a notification, or chat. */
export function userMessage(err: unknown): string {
  if (AskSqlError.is(err)) return err.userMessage;
  if (err instanceof UserFacingError) return err.message;
  const mapped = BY_CODE[codeOf(err) ?? ''];
  if (mapped) return mapped;
  return 'Could not read this database. See the AskSQL output channel for details.';
}
