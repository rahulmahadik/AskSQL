/** Shared between background.ts (writer) and sidepanel/main.tsx (reader). */
export const PENDING_QUESTION_KEY = 'asksql.pendingQuestion';

/** A question is only honored if consumed within this long of being written - guards against an old, unconsumed selection firing against a later, unrelated upload. */
export const PENDING_QUESTION_MAX_AGE_MS = 30_000;

export interface PendingQuestion {
  readonly question: string;
  readonly ts: number;
}
