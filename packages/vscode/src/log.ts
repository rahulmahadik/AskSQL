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

// The output channel's buffer is not readable through any API, so a small ring of
// recent lines is kept here for the diagnostics command. Lines are length-capped
// because a driver/provider error can echo attacker-influenceable fragments.
const RING_SIZE = 200;
const MAX_LINE_CHARS = 300;
const ring: string[] = [];

function record(level: string, message: string): void {
  const line = `[${level}] ${message}`;
  ring.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
  if (ring.length > RING_SIZE) ring.shift();
}

export function initLog(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('AskSQL', { log: true });
  ctx.subscriptions.push(channel);
}

/** Never throws if init was skipped (tests, early failures) - logging must not break the app. */
export const log = {
  info(message: string, ...args: unknown[]): void {
    record('info', message);
    channel?.info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    record('warn', message);
    channel?.warn(message, ...args);
  },
  error(message: string, err?: unknown): void {
    record('error', message);
    channel?.error(message, err instanceof Error ? err : String(err ?? ''));
  },
};

/** Recent log lines for the diagnostics report. Secrets never reach the log; lines are length-capped. */
export const recentLogLines = (): readonly string[] => ring;

/** The detail for the log; the caller decides what the user sees. */
export const detailOf = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));
