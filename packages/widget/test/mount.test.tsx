// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/index.js';

// The real chat opens a network transport on mount; this package's job is the
// shadow-DOM host, not the chat, so the chat itself is stubbed out.
vi.mock('@asksql/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@asksql/react')>();
  return {
    ...actual,
    AskSqlChat: () => null,
    AskSqlBubble: () => null,
    HttpTransport: class {
      constructor(readonly opts: unknown) {}
    },
  };
});

const handles: { unmount(): void }[] = [];
const tracked = (h: { unmount(): void }) => {
  let done = false;
  const safe = {
    unmount() {
      if (done) return;
      done = true;
      h.unmount();
    },
  };
  handles.push(safe);
  return safe;
};

afterEach(async () => {
  for (const h of handles.splice(0)) h.unmount();
  // Flush React's scheduler while jsdom still exists, or a deferred render
  // task fires after teardown and crashes the run with "window is not defined".
  await new Promise((r) => setImmediate(r));
  document.body.innerHTML = '';
});

const opts = { serverUrl: 'http://localhost:3000' };

describe('mount', () => {
  it('never attaches a shadow root to the caller\'s element, which would blank its children', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p id="keep">host content</p>';
    document.body.appendChild(host);

    tracked(mount({ ...opts, target: host }));

    // The host keeps its own children; the widget lives in an element we created.
    expect(host.querySelector('#keep')).not.toBeNull();
    expect(host.shadowRoot).toBeNull();
    expect(host.querySelector('[data-asksql-widget]')).not.toBeNull();
  });

  it('isolates its styles inside the shadow root, never the host page head', () => {
    tracked(mount(opts));
    expect(document.head.querySelector('style')).toBeNull();
    const mp = document.body.querySelector('[data-asksql-widget]')!;
    expect(mp.shadowRoot).toBeNull(); // closed mode: not reachable from outside
  });

  it('defaults to document.body when no target is given', () => {
    tracked(mount(opts));
    expect(document.body.querySelector('[data-asksql-widget]')).not.toBeNull();
  });

  it('accepts a CSS selector as the target', () => {
    const host = document.createElement('section');
    host.id = 'app';
    document.body.appendChild(host);
    tracked(mount({ ...opts, target: '#app' }));
    expect(host.querySelector('[data-asksql-widget]')).not.toBeNull();
  });

  it('names the selector that matched nothing, rather than failing obscurely', () => {
    expect(() => mount({ ...opts, target: '#missing' })).toThrow('#missing');
  });

  it('unmount removes everything it added, leaving the host as it was', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>original</p>';
    document.body.appendChild(host);
    const before = host.innerHTML;

    const handle = tracked(mount({ ...opts, target: host }));
    expect(host.querySelector('[data-asksql-widget]')).not.toBeNull();

    handle.unmount();

    expect(host.querySelector('[data-asksql-widget]')).toBeNull();
    expect(host.innerHTML).toBe(before);
  });

  it('mounts twice without the second clobbering the first', () => {
    const a = tracked(mount(opts));
    const b = tracked(mount(opts));
    expect(document.body.querySelectorAll('[data-asksql-widget]')).toHaveLength(2);
    a.unmount();
    expect(document.body.querySelectorAll('[data-asksql-widget]')).toHaveLength(1);
    b.unmount();
  });

  it('refuses to run outside a browser instead of throwing a confusing DOM error', () => {
    const doc = globalThis.document;
    // @ts-expect-error -- deliberately simulating a non-browser runtime
    delete globalThis.document;
    try {
      expect(() => mount(opts)).toThrow('must run in a browser');
    } finally {
      globalThis.document = doc;
    }
  });
});
