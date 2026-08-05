// @vitest-environment jsdom
/**
 * The options page under jsdom: what switching provider does to a stored key and
 * endpoint, and what the Row cap field is allowed to persist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';

vi.mock('@asksql/react', () => ({
  HttpTransport: class {
    async listConnections(): Promise<unknown[]> {
      return [];
    }
  },
}));

async function mount(): Promise<void> {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import('../src/options/main.js');
  });
  await screen.findByLabelText('Provider');
}

const buttonNamed = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

describe('options page', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    vi.resetModules();
    mock = installChromeMock();
    globalThis.fetch = vi.fn(async () => {
      throw new Error('no network in this test');
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    uninstallChromeMock();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it("does not carry a provider's API key or endpoint onto the next provider", async () => {
    await chrome.storage.local.set({
      'asksql.provider': {
        provider: 'openai',
        model: 'gpt-5',
        apiKey: 'sk-secret',
        baseURL: 'https://api.openai.com/v1',
      },
    });
    await mount();

    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'openai-compatible');

    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Base URL/) as HTMLInputElement).value).toBe('');

    await act(async () => buttonNamed('Save').click());
    await waitFor(() =>
      expect(mock.local.get('asksql.provider')).toEqual({ provider: 'openai-compatible', model: 'gpt-5' }),
    );
  });

  it('shows the key field for an openai-compatible endpoint, so a gateway key can be entered', async () => {
    await chrome.storage.local.set({ 'asksql.provider': { provider: 'openai-compatible', model: 'local' } });
    await mount();
    expect(screen.getByLabelText('API key')).toBeTruthy();
  });

  const saveRowCap = async (typed: string): Promise<number> => {
    await mount();
    fireEvent.change(screen.getByLabelText('Row cap'), { target: { value: typed } });
    await act(async () => buttonNamed('Save').click());
    await waitFor(() => expect(mock.local.has('asksql.engine')).toBe(true));
    return (mock.local.get('asksql.engine') as { maxRows: number }).maxRows;
  };

  it('never persists a row cap a guard would turn into LIMIT -1', async () => {
    expect(await saveRowCap('-1')).toBe(200);
  });

  it('caps the row cap at the documented ceiling rather than storing what was typed', async () => {
    expect(await saveRowCap('999999')).toBe(10_000);
  });
});
