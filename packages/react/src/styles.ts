/**
 * Self-contained styles (no Tailwind dependency for consumers). Themed via
 * CSS variables with a prefers-color-scheme default and an explicit
 * [data-asksql-theme] override. Injected once per document.
 */

export const ASKSQL_CSS = `
.asksql-root {
  --aq-bg: #ffffff; --aq-fg: #1a1a2e; --aq-muted: #6b7280; --aq-border: #e5e7eb;
  --aq-accent: #4f46e5; --aq-accent-fg: #ffffff; --aq-surface: #f9fafb;
  --aq-code-bg: #f3f4f6; --aq-danger: #dc2626; --aq-warn: #b45309; --aq-ok: #059669;
  --aq-shadow: 0 10px 40px rgba(0,0,0,.15);
  color: var(--aq-fg); font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 14px; line-height: 1.5; box-sizing: border-box;
}
.asksql-root *,.asksql-root *::before,.asksql-root *::after { box-sizing: border-box; }
@media (prefers-color-scheme: dark) {
  .asksql-root:not([data-asksql-theme="light"]) {
    --aq-bg: #0f1117; --aq-fg: #e5e7eb; --aq-muted: #9ca3af; --aq-border: #2a2f3a;
    --aq-accent: #6366f1; --aq-accent-fg: #ffffff; --aq-surface: #171a21;
    --aq-code-bg: #1c2029; --aq-danger: #f87171; --aq-warn: #fbbf24; --aq-ok: #34d399;
    --aq-shadow: 0 10px 40px rgba(0,0,0,.5);
  }
}
.asksql-root[data-asksql-theme="dark"] {
  --aq-bg: #0f1117; --aq-fg: #e5e7eb; --aq-muted: #9ca3af; --aq-border: #2a2f3a;
  --aq-accent: #6366f1; --aq-accent-fg: #ffffff; --aq-surface: #171a21;
  --aq-code-bg: #1c2029; --aq-danger: #f87171; --aq-warn: #fbbf24; --aq-ok: #34d399;
  --aq-shadow: 0 10px 40px rgba(0,0,0,.5);
}
.asksql-chat { display: flex; flex-direction: column; height: 100%; background: var(--aq-bg); }
.asksql-thread { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.asksql-empty { margin: auto; text-align: center; color: var(--aq-muted); padding: 32px; max-width: 340px; }
.asksql-empty h3 { margin: 0 0 8px; color: var(--aq-fg); font-size: 16px; }
.asksql-turn { display: flex; flex-direction: column; gap: 8px; }
.asksql-q { align-self: flex-end; background: var(--aq-accent); color: var(--aq-accent-fg);
  padding: 8px 12px; border-radius: 12px 12px 2px 12px; max-width: 85%; }
.asksql-a { align-self: flex-start; max-width: 100%; width: 100%; }
.asksql-stage { color: var(--aq-muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.asksql-spinner { width: 12px; height: 12px; border: 2px solid var(--aq-border);
  border-top-color: var(--aq-accent); border-radius: 50%; animation: aq-spin.7s linear infinite; }
@keyframes aq-spin { to { transform: rotate(360deg); } }
.asksql-sqlblock { border: 1px solid var(--aq-border); border-radius: 8px; overflow: hidden; margin: 4px 0; }
.asksql-sqlhead { display: flex; justify-content: space-between; align-items: center;
  padding: 6px 10px; background: var(--aq-surface); border-bottom: 1px solid var(--aq-border); }
.asksql-sqlhead span { font-size: 11px; text-transform: uppercase; letter-spacing:.05em; color: var(--aq-muted); }
.asksql-sqlcode { margin: 0; padding: 10px; background: var(--aq-code-bg); overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; white-space: pre; }
.asksql-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.asksql-btn { border: 1px solid var(--aq-border); background: var(--aq-bg); color: var(--aq-fg);
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; }
.asksql-btn:hover { background: var(--aq-surface); }
.asksql-btn-primary { background: var(--aq-accent); color: var(--aq-accent-fg); border-color: var(--aq-accent); }
.asksql-btn-primary:hover { filter: brightness(1.08); }
.asksql-btn:disabled { opacity:.5; cursor: not-allowed; }
.asksql-explain { color: var(--aq-muted); font-size: 13px; margin: 2px 0; }
.asksql-warn { color: var(--aq-warn); font-size: 12px; }
.asksql-error { color: var(--aq-danger); font-size: 13px; padding: 8px 12px;
  border: 1px solid var(--aq-danger); border-radius: 8px; background: color-mix(in srgb, var(--aq-danger) 8%, transparent); }
.asksql-tablewrap { overflow-x: auto; border: 1px solid var(--aq-border); border-radius: 8px; max-height: 360px; overflow-y: auto; }
.asksql-table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.asksql-table th { position: sticky; top: 0; background: var(--aq-surface); text-align: left;
  padding: 6px 10px; border-bottom: 1px solid var(--aq-border); white-space: nowrap; font-weight: 600; }
.asksql-table th small { color: var(--aq-muted); font-weight: 400; margin-left: 4px; }
.asksql-table td { padding: 5px 10px; border-bottom: 1px solid var(--aq-border); vertical-align: top;
  max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.asksql-cell-null { color: var(--aq-muted); font-style: italic; }
.asksql-cell-json { font-family: ui-monospace, monospace; color: var(--aq-accent); }
.asksql-cell-binary { color: var(--aq-muted); }
.asksql-meta { color: var(--aq-muted); font-size: 12px; display: flex; gap: 12px; align-items: center; padding: 4px 0; flex-wrap: wrap; }
.asksql-input { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--aq-border); background: var(--aq-bg); }
.asksql-input textarea { flex: 1; resize: none; border: 1px solid var(--aq-border); border-radius: 8px;
  padding: 8px 12px; font: inherit; background: var(--aq-bg); color: var(--aq-fg); min-height: 40px; max-height: 120px; }
.asksql-input textarea:focus { outline: 2px solid var(--aq-accent); outline-offset: -1px; }
.asksql-picker { padding: 8px 12px; border-bottom: 1px solid var(--aq-border); background: var(--aq-surface); }
.asksql-picker select { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--aq-border);
  background: var(--aq-bg); color: var(--aq-fg); }
/* Bubble */
.asksql-bubble-btn { position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px; border-radius: 50%;
  background: var(--aq-accent); color: var(--aq-accent-fg); border: none; cursor: pointer; box-shadow: var(--aq-shadow);
  font-size: 24px; display: flex; align-items: center; justify-content: center; z-index: 2147483000; }
.asksql-bubble-panel { position: fixed; bottom: 92px; right: 24px; width: 420px; max-width: calc(100vw - 32px);
  height: 600px; max-height: calc(100vh - 120px); background: var(--aq-bg); border: 1px solid var(--aq-border);
  border-radius: 14px; box-shadow: var(--aq-shadow); overflow: hidden; z-index: 2147483000; display: flex; flex-direction: column; }
.asksql-bubble-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px;
  border-bottom: 1px solid var(--aq-border); font-weight: 600; }
.asksql-bubble-head button { background: none; border: none; color: var(--aq-muted); cursor: pointer; font-size: 20px; }
@media (max-width: 480px) {.asksql-bubble-panel { right: 8px; bottom: 80px; width: calc(100vw - 16px); } }
/* Editable SQL */
.asksql-sqledit { width: 100%; min-height: 90px; border: none; padding: 10px; background: var(--aq-code-bg); color: var(--aq-fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; resize: vertical; }
.asksql-sqledit:focus { outline: 2px solid var(--aq-accent); outline-offset: -2px; }
/* Schema browser */
.asksql-schema { display: flex; flex-direction: column; height: 100%; background: var(--aq-bg); }
.asksql-schema-search { margin: 8px; padding: 6px 10px; border: 1px solid var(--aq-border); border-radius: 6px;
  background: var(--aq-bg); color: var(--aq-fg); font: inherit; }
.asksql-schema-list { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
.asksql-schema-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.asksql-schema-toggle { flex: 1; text-align: left; background: none; border: none; color: var(--aq-fg); cursor: pointer;
  padding: 4px 2px; font: inherit; }
.asksql-schema-icon { color: var(--aq-muted); }
.asksql-schema-tag { color: var(--aq-accent); font-size: 11px; font-style: normal; }
.asksql-schema-cols { padding: 2px 0 6px 20px; }
.asksql-schema-col { display: flex; gap: 6px; align-items: center; padding: 2px 0; font-size: 12.5px; flex-wrap: wrap; }
.asksql-schema-colname { font-weight: 500; }
.asksql-schema-coltype { color: var(--aq-muted); font-family: ui-monospace, monospace; font-size: 11.5px; }
.asksql-schema-badge { background: var(--aq-surface); border: 1px solid var(--aq-border); border-radius: 4px;
  padding: 0 4px; font-size: 10px; color: var(--aq-muted); }
.asksql-schema-enum { color: var(--aq-accent); font-size: 10px; }
.asksql-schema-req { color: var(--aq-warn); font-size: 10px; }
/* Chart */
.asksql-chart { margin: 0; border: 1px solid var(--aq-border); border-radius: 8px; padding: 8px; background: var(--aq-bg); }
.asksql-chart-axis { stroke: var(--aq-border); stroke-width: 1; }
.asksql-chart-xlabel,.asksql-chart-ylabel { fill: var(--aq-muted); font-size: 10px; }
.asksql-chart-legend { display: flex; gap: 12px; flex-wrap: wrap; padding: 4px 8px 0; font-size: 12px; color: var(--aq-muted); }
.asksql-chart-legend span { display: inline-flex; align-items: center; gap: 4px; }
.asksql-chart-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
`;

let injected = false;

/**
 * Inject the stylesheet once. SSR-safe: a no-op when `document` is absent
 * (server render), so importing/rendering components in Next.js never
 * crashes. Pass a `nonce` for strict-CSP pages (`style-src 'self' 'nonce-...'`)
 * so the injected `<style>` is whitelisted; alternatively skip injection
 * entirely and ship {@link ASKSQL_CSS} in your own stylesheet.
 */
export function ensureStyles(doc?: Document, nonce?: string): void {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!d || injected) return;
  const style = d.createElement('style');
  style.setAttribute('data-asksql', '');
  if (nonce) style.setAttribute('nonce', nonce);
  style.textContent = ASKSQL_CSS;
  d.head.appendChild(style);
  injected = true;
}
