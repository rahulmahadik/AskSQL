import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, uninstallChromeMock, type ChromeMock } from './chromeMock.js';
import { PENDING_QUESTION_KEY, type PendingQuestion } from '../src/constants.js';

const MENU_ID = 'asksql-ask-about-selection';

describe('background', () => {
  let mock: ChromeMock;

  beforeEach(() => {
    vi.resetModules();
    mock = installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
    vi.restoreAllMocks();
  });

  it('onInstalled sets the side panel to open on the toolbar click and registers the selection menu', async () => {
    await import('../src/background.js');
    mock.fireOnInstalled();
    await Promise.resolve();

    expect(mock.setPanelBehaviorCalls).toEqual([{ openPanelOnActionClick: true }]);
    expect(mock.contextMenuCreateCalls).toEqual([
      { id: MENU_ID, title: 'Ask AskSQL about selection', contexts: ['selection'] },
    ]);
  });

  it('clicking the menu with a real selection opens the side panel and hands off the question', async () => {
    await import('../src/background.js');
    mock.fireContextMenuClick({ menuItemId: MENU_ID, selectionText: '  how many rows?  ' }, { id: 7 });
    await Promise.resolve();

    expect(mock.sidePanelOpenCalls).toEqual([{ tabId: 7 }]);
    const stored = mock.session.get(PENDING_QUESTION_KEY) as PendingQuestion;
    expect(stored.question).toBe('how many rows?');
    expect(typeof stored.ts).toBe('number');
  });

  it('ignores a click for a different menu item, a tab with no id, or no selection', async () => {
    await import('../src/background.js');
    mock.fireContextMenuClick({ menuItemId: 'something-else', selectionText: 'x' }, { id: 1 });
    mock.fireContextMenuClick({ menuItemId: MENU_ID, selectionText: 'x' }, {});
    mock.fireContextMenuClick({ menuItemId: MENU_ID, selectionText: '' }, { id: 1 });
    await Promise.resolve();

    expect(mock.sidePanelOpenCalls).toEqual([]);
    expect(mock.session.size).toBe(0);
  });

  it('logs (but does not throw) when setPanelBehavior rejects', async () => {
    mock.failNext.setPanelBehavior = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../src/background.js');
    mock.fireOnInstalled();
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('setPanelBehavior'), expect.any(Error));
  });

  it('logs when contextMenus.create reports a lastError', async () => {
    mock.failNext.contextMenusCreate = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../src/background.js');
    mock.fireOnInstalled();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('contextMenus.create'), {
      message: 'duplicate id',
    });
  });

  it('logs when sidePanel.open rejects', async () => {
    mock.failNext.sidePanelOpen = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../src/background.js');
    mock.fireContextMenuClick({ menuItemId: MENU_ID, selectionText: 'x' }, { id: 1 });
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('sidePanel.open'), expect.any(Error));
  });

  it('logs when the pending-question handoff fails to write to session storage', async () => {
    mock.failNext.storageSessionSet = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await import('../src/background.js');
    mock.fireContextMenuClick({ menuItemId: MENU_ID, selectionText: 'x' }, { id: 1 });
    await Promise.resolve();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('hand off'), expect.any(Error));
  });
});
