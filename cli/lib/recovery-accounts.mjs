import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appRootDirectory } from "./app-control-location.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

// The backend keeps profile directory locators private, so names and usage are
// joined on this computer: each local profile directory carries the generation
// marker the backend fences launches with. Usage comes from the caches the
// app's account usage meter reads: Claude's statusLine collector writes one per
// profile directory, and the Codex usage collector keys snapshots by account ID.
const PROFILE_GENERATION_FILE = ".dure-profile-generation-v1";
const MAX_PROFILE_GENERATION_BYTES = 192;
const MAX_CLAUDE_USAGE_CACHE_BYTES = 64 * 1024;
const MAX_CODEX_USAGE_CACHE_BYTES = 4 * 1024 * 1024;
const USAGE_READERS = { claude: claudeUsageReader, codex: codexUsageReader };

function readBoundedFile(path, maxBytes) {
  let descriptor;
  try {
    if (!lstatSync(path).isFile()) return undefined;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const { size } = fstatSync(descriptor);
    if (size > maxBytes) return undefined;
    const buffer = Buffer.alloc(size);
    const read = readSync(descriptor, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Maps credential generations to this computer's provider profile directory
 * names. A generation claimed by more than one directory names neither. */
function readLocalProfileNames({ providerId, accountsRoot }) {
  const names = new Map();
  const ambiguous = new Set();
  const prefix = `${providerId}-`;
  let entries;
  try {
    entries = readdirSync(accountsRoot, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix) || entry.name === prefix ||
        !/^[A-Za-z0-9_-]+$/u.test(entry.name)) continue;
    const content = readBoundedFile(join(accountsRoot, entry.name, PROFILE_GENERATION_FILE),
      MAX_PROFILE_GENERATION_BYTES);
    const generation = content?.endsWith("\n") ? content.slice(0, -1) : undefined;
    if (!isDureDomainIdV1(generation)) continue;
    if (names.has(generation)) ambiguous.add(generation);
    names.set(generation, entry.name);
  }
  for (const generation of ambiguous) names.delete(generation);
  return names;
}

/** One provider-reported limit window; a window that has reset since the
 * capture no longer describes current use. */
function usageWindow(usedPercent, resetsAtSeconds, nowMs) {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  if (resetsAtSeconds == null) return { usedPercent, resetsAtMs: null };
  if (!Number.isSafeInteger(resetsAtSeconds)) return null;
  const resetsAtMs = resetsAtSeconds * 1000;
  return resetsAtMs > nowMs ? { usedPercent, resetsAtMs } : null;
}

function usageSummary(fiveHour, weekly, capturedAtSeconds) {
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly,
    observedAtMs: Number.isSafeInteger(capturedAtSeconds) ? capturedAtSeconds * 1000 : null };
}

function readJson(path, maxBytes) {
  try {
    return JSON.parse(readBoundedFile(path, maxBytes) ?? "null");
  } catch {
    return null;
  }
}

/** Claude's statusLine collector cache, one file per profile directory under
 * the platform home (as the app reads it). Claude windows always carry a reset. */
function claudeUsageReader({ homeDirectory, nowMs }) {
  const root = join(homeDirectory, ".dure", "usage", "claude-rate-limits");
  return ({ profileName }) => {
    if (!profileName) return null;
    const limits = readJson(join(root, `${profileName}.json`), MAX_CLAUDE_USAGE_CACHE_BYTES);
    const window = (value) => Number.isSafeInteger(value?.resets_at)
      ? usageWindow(value.used_percentage, value.resets_at, nowMs) : null;
    return usageSummary(window(limits?.rate_limits?.five_hour), window(limits?.rate_limits?.seven_day),
      limits?.captured_at);
  };
}

/** The Codex usage collector's last successful App Server snapshot per account
 * ID; the general "codex" limit is the account's budget. */
function codexUsageReader({ appRoot, nowMs }) {
  const cache = readJson(join(appRoot, "codex-usage-snapshots.json"), MAX_CODEX_USAGE_CACHE_BYTES);
  const snapshots = cache?.schemaVersion === 1 && Array.isArray(cache.snapshots) ? cache.snapshots : [];
  return ({ referenceIds }) => {
    const snapshot = snapshots
      .filter((entry) => referenceIds.includes(entry?.credentialId) && Number.isSafeInteger(entry.capturedAt))
      .sort((left, right) => right.capturedAt - left.capturedAt)[0];
    const general = Array.isArray(snapshot?.rateLimits)
      ? snapshot.rateLimits.find((limit) => limit?.limitId === "codex") : undefined;
    return usageSummary(usageWindow(general?.usedPercent, general?.resetsAt, nowMs),
      usageWindow(general?.usedPercentWeekly, general?.weeklyResetsAt, nowMs), snapshot?.capturedAt);
  };
}

function validProfiles(result, providerId) {
  const profiles = result?.profiles;
  return Array.isArray(profiles) && profiles.every((profile) =>
    profile?.providerId === providerId && isDureDomainIdV1(profile.referenceId) &&
    isDureDomainIdV1(profile.credentialGeneration)) ? profiles : null;
}

/** One entry per registered credential. Client-local account IDs that the
 * backend aliased to one profile directory share its generation, so they are
 * one login; the policy-named ID is offered first. Returns null when the
 * backend result is not a profile list. */
export function summarizeRegisteredAccounts({ providerId, result, local = false,
  environment = process.env, homeDirectory = homedir(), nowMs = Date.now() }) {
  const profiles = validProfiles(result, providerId);
  if (!profiles) return null;
  const names = new Map((Array.isArray(result.policy?.accounts) ? result.policy.accounts : [])
    .filter((account) => typeof account?.name === "string" && account.name.trim())
    .map((account) => [account.profile?.referenceId, account.name.trim()]));
  const appRoot = appRootDirectory(environment, homeDirectory);
  const profileNames = local ? readLocalProfileNames({ providerId, accountsRoot: join(appRoot, "accounts") })
    : new Map();
  const readUsage = local ? USAGE_READERS[providerId]?.({ appRoot, homeDirectory, nowMs }) : undefined;
  const logins = new Map();
  for (const { referenceId, credentialGeneration } of profiles) {
    const ids = logins.get(credentialGeneration) ?? [];
    ids.push(referenceId);
    logins.set(credentialGeneration, ids);
  }
  return [...logins].map(([credentialGeneration, ids]) => {
    const referenceId = ids.find((id) => names.has(id)) ?? ids[0];
    const profileName = profileNames.get(credentialGeneration) ?? null;
    return {
      referenceId,
      aliasReferenceIds: ids.filter((id) => id !== referenceId),
      credentialGeneration,
      name: names.get(referenceId) ?? null,
      profileName,
      usage: readUsage?.({ profileName, referenceIds: ids }) ?? null,
    };
  });
}

function duration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

function formatUsage(usage, nowMs) {
  if (!usage) return "usage unknown";
  const window = (label, value) => {
    if (!value) return `${label} unknown`;
    const reset = value.resetsAtMs === null ? "reset time unknown"
      : `resets in ${duration(value.resetsAtMs - nowMs)}`;
    return `${label} ${Math.round(value.usedPercent)}% (${reset})`;
  };
  return [window("5h", usage.fiveHour), window("weekly", usage.weekly),
    ...(usage.observedAtMs === null ? [] : [`observed ${duration(nowMs - usage.observedAtMs)} ago`])]
    .join(" · ");
}

function accountLabel({ name, profileName }) {
  if (name && profileName && name !== profileName) return `${name} (${profileName})`;
  return name ?? profileName ?? "name unknown";
}

function policyState(policy) {
  if (!policy) return "not configured";
  return `${policy.enabled ? "on" : "off"}, revision ${policy.revision}`;
}

export function formatRegisteredAccounts({ providerId, backend, policy, accounts, local, nowMs = Date.now() }) {
  const lines = [`${providerId} accounts on backend ${backend} (automatic recovery: ${policyState(policy)})`];
  if (accounts.length === 0) lines.push(`  No ${providerId} accounts are registered on this backend.`);
  const idWidth = Math.max(0, ...accounts.map(({ referenceId }) => referenceId.length));
  const labelWidth = Math.max(0, ...accounts.map((account) => accountLabel(account).length));
  for (const account of accounts) {
    lines.push(`  ${account.referenceId.padEnd(idWidth)}  ${accountLabel(account).padEnd(labelWidth)}  ` +
      formatUsage(account.usage, nowMs));
    if (account.aliasReferenceIds.length) {
      lines.push(`${" ".repeat(idWidth + 4)}same login, also registered as ${account.aliasReferenceIds.join(", ")}`);
    }
  }
  if (!local) {
    lines.push(`Profile names and usage are read from this computer, so they are unknown for remote backend ${backend}.`);
  }
  lines.push("Switch with: dure runs switch-account RUN --account ID. Any ID of one login selects the same credential.");
  return lines.join("\n");
}
