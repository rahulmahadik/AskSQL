/**
 * One log channel for the whole extension.
 *
 * Users get a plain-language sentence they can act on; the driver's actual
 * message (host, port, stack, provider response) goes here instead. Raw error
 * text in a notification is both unreadable and a leak risk - a connection
 * error can carry a host and user name, and a provider error can echo request
 * details.
 *
 * `{ log: true }` gives a real LogOutputChannel, so VS Code owns the levels and
 * the user can raise verbosity from the Output panel without a setting.
 */

import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('AskSQL', { log: true });
  ctx.subscriptions.push(channel);
}

/** Never throws if init was skipped (tests, early failures) - logging must not break the app. */
export const log = {
  info(message: string, ...args: unknown[]): void {
    channel?.info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    channel?.warn(message, ...args);
  },
  error(message: string, err?: unknown): void {
    channel?.error(message, err instanceof Error ? err : String(err ?? ''));
  },
};

/** The detail for the log; the caller decides what the user sees. */
export const detailOf = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);
