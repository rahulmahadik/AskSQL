// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../src/index.js';

// The real components render here - stubbing them out is what let a stylesheet
// escape into the host page unnoticed. Only the network and the jsdom gaps they
// rely on (element scrolling) are faked.
beforeAll(() => {
  Element.prototype.scrollTo = vi.fn();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ connections: [] }), { headers: { 'content-type': 'application/json' } }),
    ),
  );
});

/** React schedules both the commit and its effects, so a mount needs two turns to settle. */
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

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
  vi.unstubAllGlobals();
});

const opts = { serverUrl: 'http://localhost:3000' };

describe('mount', () => {
  it("never attaches a shadow root to the caller's element, which would blank its children", () => {
    const host = document.createElement('div');
    host.innerHTML = '<p id="keep">host content</p>';
    document.body.appendChild(host);

    tracked(mount({ ...opts, target: host }));

    // The host keeps its own children; the widget lives in an element we created.
    expect(host.querySelector('#keep')).not.toBeNull();
    expect(host.shadowRoot).toBeNull();
    expect(host.querySelector('[data-asksql-widget]')).not.toBeNull();
  });

  it('isolates its styles inside the shadow root, never the host page head', async () => {
    tracked(mount(opts));
    // The components inject their own styles from an effect, so let it run first.
    await flush();
    expect(document.head.querySelector('style')).toBeNull();
    const mp = document.body.querySelector('[data-asksql-widget]')!;
    expect(mp.shadowRoot).toBeNull(); // closed mode: not reachable from outside
  });

  it('renders the chat and exactly one stylesheet inside the shadow root', async () => {
    const attachShadow = Element.prototype.attachShadow;
    let shadow: ShadowRoot | undefined;
    Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
      shadow = attachShadow.call(this, init);
      return shadow;
    };
    try {
      tracked(mount({ ...opts, mode: 'chat' }));
      await flush();
      expect(shadow!.querySelector('.asksql-chat')).not.toBeNull();
      expect(shadow!.querySelectorAll('style[data-asksql]')).toHaveLength(1);
      expect(document.head.querySelector('style')).toBeNull();
    } finally {
      Element.prototype.attachShadow = attachShadow;
    }
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
