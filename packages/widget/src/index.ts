/**
 * @asksql/widget - vanilla-JS embed for pages without React.
 *
 * AskSQL.mount({ target: '#chat', serverUrl: '/asksql' }) renders the React
 * bubble/chat into a SHADOW ROOT, with its styles injected there too.
 */

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AskSqlBubble, AskSqlChat, HttpTransport, ensureStyles, type AskSqlChatProps } from '@asksql/react';

export interface MountOptions {
  /** CSS selector or element to mount into. Defaults to document.body (bubble). */
  readonly target?: string | HTMLElement;
  /** Sidecar base URL (required for HTTP mode). */
  readonly serverUrl: string;
  readonly headers?: Record<string, string>;
  readonly connectionId?: string;
  readonly theme?: 'light' | 'dark' | 'auto';
  /** Gate every query behind a Run button. Off by default (results auto-run). */
  readonly requireApproval?: boolean;
  /** 'bubble' (floating, default) or 'chat' (fills the target). */
  readonly mode?: 'bubble' | 'chat';
  readonly title?: string;
  readonly suggestions?: readonly string[];
  /** CSP nonce for the injected stylesheet (strict-CSP pages). */
  readonly nonce?: string;
  /** Corner for the bubble; avoids overlapping the host's own fixed UI. */
  readonly position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  /** Distance (px) from the corner. */
  readonly offset?: number | { readonly x?: number; readonly y?: number };
  /** Stacking order relative to the host page. */
  readonly zIndex?: number;
}

export interface WidgetHandle {
  unmount(): void;
}

export function mount(options: MountOptions): WidgetHandle {
  if (typeof document === 'undefined') {
    throw new Error('AskSQL.mount must run in a browser.');
  }
  // Attach the shadow to an element we create: a shadow root hides its host's light-DOM children.
  const host = resolveTarget(options.target);
  const mountPoint = document.createElement('div');
  mountPoint.setAttribute('data-asksql-widget', '');
  host.appendChild(mountPoint);
  const shadow = mountPoint.attachShadow({ mode: 'closed' });

  // Styles go into the shadow root, never document.head, keeping the isolation intact.
  ensureStyles(shadow, options.nonce);

  const container = document.createElement('div');
  shadow.appendChild(container);

  const transport = new HttpTransport({ baseUrl: options.serverUrl, headers: options.headers });
  const props: AskSqlChatProps = {
    transport,
    connectionId: options.connectionId,
    theme: options.theme,
    requireApproval: options.requireApproval,
    suggestions: options.suggestions,
    nonce: options.nonce,
    // The components style themselves too; point them at the shadow root, not the host page.
    styleRoot: shadow,
  };

  const root: Root = createRoot(container);
  const el =
    (options.mode ?? 'bubble') === 'chat'
      ? createElement('div', { style: { height: '100%' } }, createElement(AskSqlChat, props))
      : createElement(AskSqlBubble, {
          ...props,
          title: options.title,
          position: options.position,
          offset: options.offset,
          zIndex: options.zIndex,
        });
  root.render(el);

  return {
    unmount() {
      root.unmount();
      container.remove();
      mountPoint.remove();
    },
  };
}

function resolveTarget(target?: string | HTMLElement): HTMLElement {
  if (!target) return document.body;
  if (typeof target === 'string') {
    const el = document.querySelector(target);
    if (!el) throw new Error(`AskSQL.mount: no element matches "${target}".`);
    return el as HTMLElement;
  }
  return target;
}

export const AskSQL = { mount };
export default AskSQL;
