/** Chrome adds `Origin: chrome-extension://<id>` to JSON POSTs (chat calls) but not plain GETs, even with host permission, so Ollama-style servers 403 chat while model listing works. DNR cannot forge Origin but can remove it; one fixed rule id, fully replaced per sync since only one provider origin is ever active. */
const PROVIDER_ORIGIN_STRIP_RULE_ID = 1;

/**
 * Best-effort: a managed profile can restrict this API, so a failed install
 * leaves the provider seeing the real Origin rather than breaking connecting.
 */
export async function syncProviderOriginStripRule(origin: string | undefined): Promise<void> {
  try {
    const target = origin ? new URL(origin) : undefined;
    const addRules = target
      ? [
          {
            id: PROVIDER_ORIGIN_STRIP_RULE_ID,
            priority: 1,
            action: {
              type: 'modifyHeaders' as const,
              requestHeaders: [{ header: 'origin', operation: 'remove' as const }],
            },
            condition: {
              // Pins scheme, host and port, not just the hostname every local service shares.
              urlFilter: `|${target.protocol}//${target.host}/`,
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
