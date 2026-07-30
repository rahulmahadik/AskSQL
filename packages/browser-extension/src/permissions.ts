/** Chrome match patterns cannot include a port and silently ignore any pattern that has one (the grant succeeds but does nothing), so every request/check here strips the port first. */

export function toOriginPattern(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export async function hasOriginPermission(url: string): Promise<boolean> {
  const origins = [toOriginPattern(url)];
  return chrome.permissions.contains({ origins });
}

export async function requestOriginPermission(url: string): Promise<boolean> {
  const origins = [toOriginPattern(url)];
  return chrome.permissions.request({ origins });
}

/**
 * Reset AskSQL revokes every optional origin grant, not just cleared storage -
 * chrome.permissions.remove only ever touches optional (never required)
 * permissions, so this can't accidentally strip sidePanel/storage/contextMenus.
 */
export async function removeAllGrantedOriginPermissions(): Promise<void> {
  const current = await chrome.permissions.getAll();
  const origins = current.origins ?? [];
  if (origins.length === 0) return;
  await chrome.permissions.remove({ origins });
}
