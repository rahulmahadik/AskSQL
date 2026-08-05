/** Shared by the side panel and options page: the origin a provider's requests actually go to, for permission checks. */
import { PROVIDER_API_HOST, type ProviderName } from '@asksql/core';

export function providerOrigin(provider: {
  readonly provider: ProviderName;
  readonly baseURL?: string;
}): string | undefined {
  return provider.baseURL ?? PROVIDER_API_HOST[provider.provider];
}
