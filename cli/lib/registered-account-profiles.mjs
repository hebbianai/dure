import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

/** Credential profiles registered on one backend: the exact handles runtime
 * switches and Runs launch with. Names come from the recovery policy; an
 * account outside the policy has none. Returns null for an invalid response so
 * callers refuse instead of guessing a generation. */
export async function readRegisteredAccountProfiles({ providerId, backend, requestBackend }) {
  const { result } = await requestBackend(backend.profile, {
    operation: "provider_recovery.get", requiredCapabilities: ["account_recovery.v1"],
    body: { schemaVersion: 1, providerId },
  }, backend.transportOptions);
  const profiles = result?.profiles;
  if (result?.schemaVersion !== 1 || !Array.isArray(profiles) || profiles.some((profile) =>
    profile?.schemaVersion !== 1 || profile.providerId !== providerId ||
    !isDureDomainIdV1(profile.referenceId) || !isDureDomainIdV1(profile.credentialGeneration))) {
    return null;
  }
  const names = new Map((Array.isArray(result.policy?.accounts) ? result.policy.accounts : [])
    .filter((entry) => typeof entry?.name === "string" && entry.name.trim())
    .map((entry) => [entry.profile?.referenceId, entry.name.trim()]));
  return profiles.map(({ referenceId, credentialGeneration }) => ({ referenceId, credentialGeneration,
    ...(names.has(referenceId) ? { name: names.get(referenceId) } : {}) }));
}

export function registeredAccountUnavailableMessage({ providerId, account, profiles, backendId }) {
  const choices = profiles.map(({ referenceId, name }) => name ? `${referenceId} (${name})` : referenceId);
  return `${providerId} account ${account} is not registered on backend ${backendId}. ` +
    `Usable account IDs: ${choices.join(", ") || "none"}. Account IDs are not display names; ` +
    `dure recovery get ${providerId} --backend ${backendId} lists them.`;
}
