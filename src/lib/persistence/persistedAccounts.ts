import { providerSupportsAccountProfiles } from "@/lib/agents/providerCredentials";
import { PROVIDERS, type AccountProfile, type Provider } from "@/types";

export function normalizePersistedActiveAccounts(
  value: unknown,
  accounts: AccountProfile[],
): Partial<Record<Provider, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Partial<Record<Provider, string>> = {};
  for (const [candidateProvider, candidateId] of Object.entries(value)) {
    if (
      !(candidateProvider in PROVIDERS) ||
      typeof candidateId !== "string"
    ) {
      continue;
    }
    const provider = candidateProvider as Provider;
    if (!providerSupportsAccountProfiles(provider)) continue;
    if (
      accounts.some(
        (account) =>
          account.id === candidateId && account.provider === provider,
      )
    ) {
      normalized[provider] = candidateId;
    }
  }
  return normalized;
}
