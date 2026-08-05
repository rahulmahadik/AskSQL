/** Validate a user-typed URL, then ensure (or request) the origin permission needed to fetch it. */
import { hasOriginPermission, requestOriginPermission } from './permissions.js';

function isFetchableHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // `new URL('localhost:3000')` parses as a scheme rather than throwing, so check both explicitly.
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

export async function ensureOriginAccess(url: string): Promise<boolean> {
  if (!isFetchableHttpUrl(url)) {
    throw new Error(`"${url}" is not a valid URL - include the scheme, e.g. http://localhost:3000.`);
  }
  if (await hasOriginPermission(url)) return true;
  return requestOriginPermission(url);
}

/** One shared wording for every call site that reports a denied/not-yet-granted origin permission. */
export function permissionDeniedMessage(url: string): string {
  return `AskSQL needs permission to reach ${new URL(url).hostname}. Grant access and try again.`;
}
