import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, constants }
  from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appRootDirectory } from "./app-control-location.mjs";
import { runBoundedCommand } from "./bounded-command.mjs";
import { PROVIDERS } from "./contracts/provider-catalog.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

// The backend keeps profile directory locators private, so names, sign-in and
// usage are joined on this computer: each local profile directory carries the
// generation marker the backend fences launches with. Usage comes from the
// caches the app's account usage meter reads: Claude's statusLine collector
// writes one per profile directory, and the Codex usage collector keys
// snapshots by account ID.
const PROFILE_GENERATION_FILE = ".dure-profile-generation-v1";
const MAX_PROFILE_GENERATION_BYTES = 192;
const MAX_CLAUDE_USAGE_CACHE_BYTES = 64 * 1024;
const MAX_CODEX_USAGE_CACHE_BYTES = 4 * 1024 * 1024;
const USAGE_READERS = { claude: claudeUsageReader, codex: codexUsageReader };
const SIGN_IN_READERS = { claude: claudeSignInReader };
const CLAUDE_CREDENTIAL_FILE = ".credentials.json";
const KEYCHAIN_LOOKUP_TIMEOUT_MS = 5_000;
const KEYCHAIN_ITEM_NOT_FOUND = 44;

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

/** A window is null when the provider did not report it or it reset after
 * the capture. Credits, usage resets and the latest check exist only where the
 * provider's collector records them. */
function usageSummary({ fiveHour = null, weekly = null, capturedAtSeconds, credits = null,
  usageResetsAvailable = null, lastCheck = null }) {
  if (!fiveHour && !weekly && !credits && usageResetsAvailable === null && !lastCheck) return null;
  return { fiveHour, weekly,
    observedAtMs: Number.isSafeInteger(capturedAtSeconds) ? capturedAtSeconds * 1000 : null,
    credits, usageResetsAvailable, lastCheck };
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
    return usageSummary({ fiveHour: window(limits?.rate_limits?.five_hour),
      weekly: window(limits?.rate_limits?.seven_day), capturedAtSeconds: limits?.captured_at });
  };
}

/** Claude Code keeps a CLAUDE_CONFIG_DIR login in a macOS Keychain item named
 * by the first eight hex digits of that exact directory string's SHA-256. */
export function claudeKeychainService(configDirectory) {
  return `Claude Code-credentials-${createHash("sha256").update(configDirectory).digest("hex").slice(0, 8)}`;
}

/** Asks only whether the item exists, never for its secret, so the Keychain
 * shows no access prompt. Returns "present", "absent" or "unknown". */
export async function findKeychainItem(service) {
  const result = await runBoundedCommand(["/usr/bin/security", "find-generic-password", "-s", service],
    { timeoutMs: KEYCHAIN_LOOKUP_TIMEOUT_MS, maxCaptureBytes: 64 * 1024 });
  if (result.kind === "success") return "present";
  return result.kind === "nonzero" && result.code === KEYCHAIN_ITEM_NOT_FOUND ? "absent" : "unknown";
}

function credentialFileState(path) {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && metadata.size > 0 ? "present" : "unknown";
  } catch (error) {
    return error?.code === "ENOENT" ? "absent" : "unknown";
  }
}

/** Whether a launch on this profile directory finds a Claude login, by the
 * rule the app's login check uses: the profile's credential file or, on
 * macOS, the Keychain item for the directory the backend launches with (its
 * real path). Only a confirmed absence reads as signed out (false); anything
 * unreadable stays unknown (null). */
function claudeSignInReader({ accountsRoot, platform, keychainLookup }) {
  return async ({ profileName }) => {
    if (!profileName) return null;
    const directory = join(accountsRoot, profileName);
    const file = credentialFileState(join(directory, CLAUDE_CREDENTIAL_FILE));
    if (file === "present") return true;
    if (platform !== "darwin") return file === "absent" ? false : null;
    let launchDirectory;
    try {
      launchDirectory = realpathSync(directory);
    } catch {
      return null;
    }
    const item = await keychainLookup(claudeKeychainService(launchDirectory)).catch(() => "unknown");
    if (item === "present") return true;
    return item === "absent" && file === "absent" ? false : null;
  };
}

function newestBy(entries, field) {
  return entries.filter((entry) => Number.isSafeInteger(entry[field]))
    .sort((left, right) => right[field] - left[field])[0];
}

/** An account past its window keeps working on purchased credits, so the
 * balance explains a full window that does not stop work. */
function codexCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  const raw = typeof credits.balance === "string" ? credits.balance.trim() : "";
  const balance = raw ? Number(raw) : Number.NaN;
  return { unlimited: credits.unlimited === true,
    balance: Number.isFinite(balance) && balance >= 0 ? balance : null };
}

/** The Codex usage collector's latest App Server snapshot among a login's
 * account IDs; the general "codex" limit is the account's budget. A failed
 * probe keeps the last successful reading and records its own attempt. */
function codexUsageReader({ appRoot, nowMs }) {
  const cache = readJson(join(appRoot, "codex-usage-snapshots.json"), MAX_CODEX_USAGE_CACHE_BYTES);
  const snapshots = cache?.schemaVersion === 1 && Array.isArray(cache.snapshots)
    ? cache.snapshots.filter((entry) => entry && typeof entry === "object") : [];
  return ({ referenceIds }) => {
    const login = snapshots.filter((entry) => referenceIds.includes(entry.credentialId));
    const snapshot = newestBy(login, "capturedAt");
    const attempt = newestBy(login, "attemptedAt");
    const general = Array.isArray(snapshot?.rateLimits)
      ? snapshot.rateLimits.find((limit) => limit?.limitId === "codex") : undefined;
    const resets = snapshot?.rateLimitResetsAvailable;
    return usageSummary({
      fiveHour: usageWindow(general?.usedPercent, general?.resetsAt, nowMs),
      weekly: usageWindow(general?.usedPercentWeekly, general?.weeklyResetsAt, nowMs),
      capturedAtSeconds: snapshot?.capturedAt,
      credits: codexCredits(general?.credits),
      usageResetsAvailable: Number.isSafeInteger(resets) && resets >= 0 ? resets : null,
      lastCheck: attempt ? { checkedAtMs: attempt.attemptedAt * 1000,
        error: typeof attempt.error === "string" && attempt.error ? attempt.error : null } : null,
    });
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
export async function summarizeRegisteredAccounts({ providerId, result, local = false,
  environment = process.env, homeDirectory = homedir(), nowMs = Date.now(),
  platform = process.platform, keychainLookup = findKeychainItem }) {
  const profiles = validProfiles(result, providerId);
  if (!profiles) return null;
  const names = new Map((Array.isArray(result.policy?.accounts) ? result.policy.accounts : [])
    .filter((account) => typeof account?.name === "string" && account.name.trim())
    .map((account) => [account.profile?.referenceId, account.name.trim()]));
  const appRoot = appRootDirectory(environment, homeDirectory);
  const accountsRoot = join(appRoot, "accounts");
  const profileNames = local ? readLocalProfileNames({ providerId, accountsRoot }) : new Map();
  const readUsage = local ? USAGE_READERS[providerId]?.({ appRoot, homeDirectory, nowMs }) : undefined;
  const readSignIn = local ? SIGN_IN_READERS[providerId]?.({ accountsRoot, platform, keychainLookup })
    : undefined;
  const logins = new Map();
  for (const { referenceId, credentialGeneration } of profiles) {
    const ids = logins.get(credentialGeneration) ?? [];
    ids.push(referenceId);
    logins.set(credentialGeneration, ids);
  }
  return Promise.all([...logins].map(async ([credentialGeneration, ids]) => {
    const referenceId = ids.find((id) => names.has(id)) ?? ids[0];
    const profileName = profileNames.get(credentialGeneration) ?? null;
    return {
      referenceId,
      aliasReferenceIds: ids.filter((id) => id !== referenceId),
      credentialGeneration,
      name: names.get(referenceId) ?? null,
      profileName,
      signedIn: (await readSignIn?.({ profileName })) ?? null,
      usage: readUsage?.({ profileName, referenceIds: ids }) ?? null,
    };
  }));
}

function duration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

const CHECK_FAILURES = { codex_usage_not_signed_in: "not signed in" };

function formatCheckFailure({ checkedAtMs, error }, nowMs) {
  const reason = CHECK_FAILURES[error] ?? (/^[a-z0-9_]{1,80}$/u.test(error) ? error : "error");
  return `check failed ${duration(nowMs - checkedAtMs)} ago (${reason})`;
}

/** Lists only the windows the provider currently describes; a provider that
 * reports a weekly window alone has no 5h limit to show. */
function formatUsage(usage, nowMs) {
  if (!usage) return "usage unknown";
  const window = (label, value) => {
    const reset = value.resetsAtMs === null ? "reset time unknown"
      : `resets in ${duration(value.resetsAtMs - nowMs)}`;
    return `${label} ${Math.round(value.usedPercent)}% (${reset})`;
  };
  const windows = [["5h", usage.fiveHour], ["weekly", usage.weekly]]
    .filter(([, value]) => value).map(([label, value]) => window(label, value));
  const { credits, usageResetsAvailable, lastCheck } = usage;
  return [...(windows.length ? windows : ["usage unknown"]),
    ...(credits?.unlimited ? ["unlimited credits"] : credits?.balance > 0
      ? [`credits ${credits.balance.toLocaleString("en-US", { maximumFractionDigits: 2 })}`] : []),
    ...(usageResetsAvailable > 0 ? [`usage resets ${usageResetsAvailable}`] : []),
    ...(usage.observedAtMs === null ? [] : [`observed ${duration(nowMs - usage.observedAtMs)} ago`]),
    ...(lastCheck?.error ? [formatCheckFailure(lastCheck, nowMs)] : [])]
    .join(" · ");
}

function accountLabel({ name, profileName }) {
  if (name && profileName && name !== profileName) return `${name} (${profileName})`;
  return name ?? profileName ?? "name unknown";
}

/** A shell word for the profile directory, under ~ when it lies in HOME. */
function shellPath(path, homeDirectory) {
  const display = path.startsWith(`${homeDirectory}/`) ? `~/${path.slice(homeDirectory.length + 1)}` : path;
  if (/^[A-Za-z0-9_./~-]+$/u.test(display)) return display;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** The provider's own sign-in, pointed at each signed-out profile directory. */
function signInLines({ providerId, accounts, environment, homeDirectory }) {
  const provider = Object.hasOwn(PROVIDERS, providerId) ? PROVIDERS[providerId] : undefined;
  const signedOut = accounts.filter(({ signedIn, profileName }) => signedIn === false && profileName);
  if (!signedOut.length || !provider?.configEnv || !provider.loginCmd) return [];
  const accountsRoot = join(appRootDirectory(environment, homeDirectory), "accounts");
  return ["A signed-out login stops at the provider's sign-in screen. Sign it in on this computer first:",
    ...signedOut.map(({ profileName }) => `  ${provider.configEnv}=` +
      `${shellPath(join(accountsRoot, profileName), homeDirectory)} ${provider.loginCmd}`)];
}

function policyState(policy) {
  if (!policy) return "not configured";
  return `${policy.enabled ? "on" : "off"}, revision ${policy.revision}`;
}

export function formatRegisteredAccounts({ providerId, backend, policy, accounts, local, nowMs = Date.now(),
  environment = process.env, homeDirectory = homedir() }) {
  const lines = [`${providerId} accounts on backend ${backend} (automatic recovery: ${policyState(policy)})`];
  if (accounts.length === 0) lines.push(`  No ${providerId} accounts are registered on this backend.`);
  const idWidth = Math.max(0, ...accounts.map(({ referenceId }) => referenceId.length));
  const labelWidth = Math.max(0, ...accounts.map((account) => accountLabel(account).length));
  for (const account of accounts) {
    lines.push(`  ${account.referenceId.padEnd(idWidth)}  ${accountLabel(account).padEnd(labelWidth)}  ` +
      `${account.signedIn === false ? "signed out · " : ""}${formatUsage(account.usage, nowMs)}`);
    if (account.aliasReferenceIds.length) {
      lines.push(`${" ".repeat(idWidth + 4)}same login, also registered as ${account.aliasReferenceIds.join(", ")}`);
    }
  }
  if (!local) {
    lines.push(`Profile names, sign-in and usage are read from this computer, so they are unknown for remote backend ${backend}.`);
  }
  lines.push(...signInLines({ providerId, accounts, environment, homeDirectory }));
  lines.push("Switch with: dure runs switch-account RUN --account ID. Any ID of one login selects the same credential.");
  lines.push("Use the provider's default login, which needs no registration: dure runs switch-account RUN --account default --confirm-restart");
  lines.push(`Add a login signed in on this backend's host: dure accounts register ${providerId} --dir NAME --backend ${backend} (see dure accounts help)`);
  return lines.join("\n");
}
