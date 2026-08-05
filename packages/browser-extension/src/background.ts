/** Thin service worker - it only routes; the side panel does the real work. Context-menu `info.selectionText` arrives with no permission needed (no activeTab, no content script). */

import { PENDING_QUESTION_KEY, type PendingQuestion } from './constants.js';

const ASK_SELECTION_MENU_ID = 'asksql-ask-about-selection';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) =>
      console.error('AskSQL: setPanelBehavior failed - clicking the toolbar icon may not open the side panel', err),
    );
  chrome.contextMenus.create(
    {
      id: ASK_SELECTION_MENU_ID,
      title: 'Ask AskSQL about selection',
      contexts: ['selection'],
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error(
          'AskSQL: contextMenus.create failed - "Ask AskSQL about selection" will be missing',
          chrome.runtime.lastError,
        );
      }
    },
  );
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== ASK_SELECTION_MENU_ID || !tab?.id || !info.selectionText) return;
  // MUST be called synchronously, before any await, while the click's user-gesture token is live.
  chrome.sidePanel.open({ tabId: tab.id }).catch((err: unknown) => console.error('AskSQL: sidePanel.open failed', err));
  // Hand off via session storage, not a runtime message: the panel may not be mounted yet and an unheard message is dropped; the panel watches storage.onChanged.
  const pending: PendingQuestion = { question: info.selectionText.trim(), ts: Date.now() };
  chrome.storage.session
    .set({ [PENDING_QUESTION_KEY]: pending })
    .catch((err: unknown) => console.error('AskSQL: could not hand off the selected question to the side panel', err));
});
