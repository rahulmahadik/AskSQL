/** Chrome adds `Origin: chrome-extension://<id>` to JSON POSTs (chat calls) but not plain GETs, even with host permission, so Ollama-style servers 403 chat while model listing works. DNR cannot forge Origin but can remove it; one fixed rule id, fully replaced per sync since only one provider origin is ever active. */
const PROVIDER_ORIGIN_STRIP_RULE_ID = 1;

/**
 * Best-effort: a managed/locked-down profile can restrict this API. Failing to
 * install the rule only costs the pre-existing behavior (the provider sees the
 * real Origin), so it must never break connecting.
 */
export async function syncProviderOriginStripRule(origin: string | undefined): Promise<void> {
  try {
    const addRules = origin
      ? [
          {
            id: PROVIDER_ORIGIN_STRIP_RULE_ID,
            priority: 1,
            action: {
              type: 'modifyHeaders' as const,
              requestHeaders: [{ header: 'origin', operation: 'remove' as const }],
            },
            condition: {
              requestDomains: [new URL(origin).hostname],
              resourceTypes: ['xmlhttprequest' as const],
            },
          },
        ]
      : [];
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [PROVIDER_ORIGIN_STRIP_RULE_ID],
      addRules,
    });
  } catch (err) {
    console.warn('AskSQL: could not install the Origin-strip rule; a strict local provider may reject requests', err);
  }
}

export async function clearProviderOriginStripRule(): Promise<void> {
  await syncProviderOriginStripRule(undefined);
}
