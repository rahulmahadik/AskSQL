/** No telemetry (see PRIVACY.md), so the console is the only diagnostic trail: log the full error there and return a short user-facing message. */
export function reportError(action: string, err: unknown): string {
  console.error(`AskSQL: ${action} failed`, err);
  return err instanceof Error ? err.message : String(err);
}
