/** Every path to a provider origin (Test provider, Fetch models, chat) needs both the origin permission and the Origin-strip rule; bundled so no call site gets one without the other. */
import { ensureOriginAccess } from './originAccess.js';
import { syncProviderOriginStripRule } from './originHeaderRule.js';

export async function ensureProviderOriginAccess(origin: string): Promise<boolean> {
  const granted = await ensureOriginAccess(origin);
  // The rule only applies to an origin the extension already has host access to, so grant first.
  if (granted) await syncProviderOriginStripRule(origin);
  return granted;
}
