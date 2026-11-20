import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "vitest";
import {
  CLAUDE_LAUNCH_ENVIRONMENT_REMOVALS,
  CLAUDE_LAUNCH_STATE_ROOTS,
  claudeAuthStatus,
  claudeKeychainService,
} from "../cli/lib/recovery-accounts.mjs";
import { parseRecoveryCommand, runRecoveryCommand } from "../cli/lib/recovery-command.mjs";

const profile = { schemaVersion: 1, providerId: "codex", referenceId: "team",
  credentialGeneration: "registered-generation" };
const accounts = [{ profile, name: "Team account" }];

function fixture(requestBackend) {
  const output = [];
  const routes = [];
  return { output, routes, options: {
    resolveBackend: async (selection) => {
      routes.push(selection);
      return { profile: { id: "shared", transport: { kind: "ssh_stdio" } },
        transportOptions: { deadlineMs: 5000 } };
    }, requestBackend, output: (text) => output.push(JSON.parse(text)),
  } };
}

test("recovery settings use the selected backend and exact policy revision without registering accounts", async () => {
  const requests = [];
  const f = fixture(async (route, request, options) => {
    requests.push({ route, request, options });
    return { result: { schemaVersion: 1, policy: { revision: 4 } } };
  });
  assert.equal(await runRecoveryCommand(["put", "codex", "--enabled", "true", "--accounts",
    JSON.stringify(accounts), "--expected-revision", "3", "--idempotency-key", "same-request",
    "--backend", "shared", "--json"], f.options), true);
  assert.deepEqual(f.routes, [{ backend: "shared", backendSpecified: true }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].route.id, "shared");
  assert.deepEqual(requests[0].request, { operation: "provider_recovery.put",
    requiredCapabilities: ["account_recovery.v1"], body: {
      schemaVersion: 1, providerId: "codex", expectedRevision: 3,
      idempotencyKey: "same-request", enabled: true, accounts,
    } });
  assert.equal(f.output[0].policy.revision, 4);
});

test("a lost mutation response exposes the same retry identity and does not retry or change accounts", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error("connection closed"); });
  assert.equal(await runRecoveryCommand(["put", "codex", "--enabled", "false", "--accounts", "[]",
    "--expected-revision", "4", "--idempotency-key", "retain-key"], f.options), false);
  assert.equal(calls, 1);
  assert.equal(f.output[0].idempotencyKey, "retain-key");
});

test("status is read only and returns the backend outcome unchanged", async () => {
  const result = { schemaVersion: 1, recovery: { attemptId: "attempt-a", failureItemId: "failure-a",
    target: accounts[0], stopped: null, turnState: "uncertain", createdAtMs: 123 } };
  const f = fixture(async (_, request) => {
    assert.equal(request.operation, "agent_recovery.read");
    assert.deepEqual(request.body, { schemaVersion: 1, agentId: "agent-a" });
    return { result };
  });
  assert.equal(await runRecoveryCommand(["status", "agent-a"], f.options), true);
  assert.deepEqual(f.output, [result]);
});

test("optional unknown telemetry reaches the backend without a credential availability probe", async () => {
  const observations = [{ profile, usedPercent: null, observedAtMs: 123 }];
  const f = fixture(async (_, request) => {
    assert.equal(request.operation, "provider_recovery.observe_usage");
    assert.deepEqual(request.body, { schemaVersion: 1, observations });
    return { result: { schemaVersion: 1 } };
  });
  assert.equal(await runRecoveryCommand(["observe", "--observations", JSON.stringify(observations)], f.options), true);
});

test("policy edits require an explicit revision, setting and account pool", () => {
  for (const args of [
    ["put", "codex"],
    ["put", "codex", "--enabled", "true", "--accounts", "[]"],
    ["put", "codex", "--enabled", "true", "--expected-revision", "0"],
    ["get", "codex", "--accounts", "[]"],
  ]) assert.throws(() => parseRecoveryCommand(args));
});

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function claudeProfile(referenceId, credentialGeneration) {
  return { schemaVersion: 1, providerId: "claude", referenceId, credentialGeneration };
}

/** One disposable HOME with the default Dure home, provider profile
 * directories, their credential files and the collector's per-profile usage
 * cache. */
function localAccountsFixture({ profiles = {}, usage = {}, extraDirectories = [], credentials = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dure-recovery-accounts-"));
  const dureHome = join(home, ".dure");
  for (const [directory, generation] of Object.entries(profiles)) {
    mkdirSync(join(dureHome, "accounts", directory), { recursive: true, mode: 0o700 });
    writeFileSync(join(dureHome, "accounts", directory, ".dure-profile-generation-v1"),
      `${generation}\n`, { mode: 0o600 });
  }
  for (const directory of extraDirectories) {
    mkdirSync(join(dureHome, "accounts", directory), { recursive: true, mode: 0o700 });
  }
  for (const [directory, content] of Object.entries(credentials)) {
    writeFileSync(join(dureHome, "accounts", directory, ".credentials.json"), content, { mode: 0o600 });
  }
  const usageRoot = join(dureHome, "usage", "claude-rate-limits");
  mkdirSync(usageRoot, { recursive: true });
  for (const [directory, payload] of Object.entries(usage)) {
    writeFileSync(join(usageRoot, `${directory}.json`),
      typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  return { home, environment: { HOME: home } };
}

const noKeychain = async () => { throw new Error("only macOS keeps Claude logins in the Keychain"); };
// Claude Code gives no answer, so the stored credential decides.
const noAuthStatus = async () => undefined;

function accountsCommand({ result, kind = "local", home, environment, args = [],
  platform = "linux", keychainLookup = noKeychain, authStatus = noAuthStatus }) {
  const output = [];
  const requests = [];
  return { output, requests, run: () => runRecoveryCommand(["get", "claude", ...args], {
    resolveBackend: async () => ({ profile: { id: kind === "local" ? "local" : "shared",
      transport: { kind } }, transportOptions: {} }),
    requestBackend: async (_, request) => { requests.push(request); return { result }; },
    output: (text) => output.push(text),
    environment, homeDirectory: home, now: () => NOW, platform, keychainLookup, authStatus,
  }) };
}

const seconds = (ms) => Math.floor(ms / 1000);

test("get lists each login once with its local profile name, usage windows and reset times", async () => {
  const { home, environment } = localAccountsFixture({
    profiles: { "claude-work": "credential-v2-work", "claude-personal": "credential-v2-personal",
      "claude-retired": "credential-v2-retired" },
    extraDirectories: ["claude-work.lock"],
    credentials: { "claude-work": "{}", "claude-personal": "{}" },
    usage: {
      "claude-work": { captured_at: seconds(NOW - 12 * MINUTE), rate_limits: {
        five_hour: { used_percentage: 42, resets_at: seconds(NOW + 2 * HOUR + 10 * MINUTE) },
        seven_day: { used_percentage: 61.4, resets_at: seconds(NOW + 99 * HOUR) } } },
      // Both windows reset after the capture: the snapshot no longer describes them.
      "claude-personal": { captured_at: seconds(NOW - 9 * HOUR), rate_limits: {
        five_hour: { used_percentage: 97, resets_at: seconds(NOW - 4 * HOUR) } } },
    },
  });
  const result = { schemaVersion: 1, policy: null, profiles: [
    claudeProfile("acc-personal", "credential-v2-personal"),
    claudeProfile("acc-work-a", "credential-v2-work"),
    claudeProfile("acc-work-b", "credential-v2-work"),
    claudeProfile("acc-unmatched", "credential-v2-elsewhere"),
  ] };
  const human = accountsCommand({ result, home, environment });
  assert.equal(await human.run(), true);
  assert.deepEqual(human.requests, [{ operation: "provider_recovery.get",
    requiredCapabilities: ["account_recovery.v1"], body: { schemaVersion: 1, providerId: "claude" } }]);
  assert.equal(human.output.join("\n"), [
    "claude accounts on backend local (automatic recovery: not configured)",
    "  acc-personal   claude-personal  usage unknown",
    "  acc-work-a     claude-work      5h 42% (resets in 2h 10m) · weekly 61% (resets in 4d 3h) · observed 12m ago",
    "                 same login, also registered as acc-work-b",
    "  acc-unmatched  name unknown     usage unknown",
    "Switch with: dure runs switch-account RUN --account ID. Any ID of one login selects the same credential.",
    "Use the provider's default login, which needs no registration: dure runs switch-account RUN --account default --confirm-restart",
    "Add a login signed in on this backend's host: dure accounts register claude --dir NAME --backend local (see dure accounts help)",
  ].join("\n"));

  const json = accountsCommand({ result, home, environment, args: ["--json"] });
  assert.equal(await json.run(), true);
  const report = JSON.parse(json.output[0]);
  assert.deepEqual({ ...report, registeredAccounts: undefined }, { ...result, registeredAccounts: undefined });
  assert.deepEqual(report.registeredAccounts, [
    { referenceId: "acc-personal", aliasReferenceIds: [], credentialGeneration: "credential-v2-personal",
      name: null, profileName: "claude-personal", signedIn: true, usage: null },
    { referenceId: "acc-work-a", aliasReferenceIds: ["acc-work-b"], credentialGeneration: "credential-v2-work",
      name: null, profileName: "claude-work", signedIn: true, usage: {
        fiveHour: { usedPercent: 42, resetsAtMs: NOW + 2 * HOUR + 10 * MINUTE },
        weekly: { usedPercent: 61.4, resetsAtMs: NOW + 99 * HOUR },
        observedAtMs: NOW - 12 * MINUTE, credits: null, usageResetsAvailable: null, lastCheck: null } },
    { referenceId: "acc-unmatched", aliasReferenceIds: [], credentialGeneration: "credential-v2-elsewhere",
      name: null, profileName: null, signedIn: null, usage: null },
  ]);
});

test("a policy name labels its login and its ID is offered first", async () => {
  const { home, environment } = localAccountsFixture({ profiles: { "claude-work": "credential-v2-work" },
    credentials: { "claude-work": "{}" } });
  const named = claudeProfile("acc-work-b", "credential-v2-work");
  const result = { schemaVersion: 1, profiles: [claudeProfile("acc-work-a", "credential-v2-work"), named],
    policy: { schemaVersion: 1, providerId: "claude", revision: 3, enabled: true,
      accounts: [{ profile: named, name: "Work" }], activatedAtMs: 1, updatedAtMs: 2 } };
  const command = accountsCommand({ result, home, environment });
  assert.equal(await command.run(), true);
  assert.deepEqual(command.output.join("\n").split("\n").slice(0, 3), [
    "claude accounts on backend local (automatic recovery: on, revision 3)",
    "  acc-work-b  Work (claude-work)  usage unknown",
    "              same login, also registered as acc-work-a",
  ]);
});

test("a remote backend's accounts are not matched against this computer's profiles", async () => {
  const { home, environment } = localAccountsFixture({
    profiles: { "claude-work": "credential-v2-work" },
    usage: { "claude-work": { captured_at: seconds(NOW), rate_limits: {
      five_hour: { used_percentage: 5, resets_at: seconds(NOW + HOUR) } } } },
  });
  const result = { schemaVersion: 1, policy: null, profiles: [claudeProfile("acc-work-a", "credential-v2-work")] };
  const command = accountsCommand({ result, kind: "ssh", home, environment, args: ["--json"] });
  assert.equal(await command.run(), true);
  assert.deepEqual(JSON.parse(command.output[0]).registeredAccounts, [
    { referenceId: "acc-work-a", aliasReferenceIds: [], credentialGeneration: "credential-v2-work",
      name: null, profileName: null, signedIn: null, usage: null },
  ]);
  const human = accountsCommand({ result, kind: "ssh", home, environment });
  assert.equal(await human.run(), true);
  assert.match(human.output.join("\n"),
    /Profile names, sign-in and usage are read from this computer, so they are unknown for remote backend shared\./);
});

test("unreadable markers or usage caches leave the name or usage unknown", async () => {
  const { home, environment } = localAccountsFixture({
    profiles: { "claude-work": "credential-v2-work", "claude-copy": "credential-v2-work" },
    usage: { "claude-solo": "{not json" },
  });
  mkdirSync(join(home, ".dure", "accounts", "claude-solo"), { mode: 0o700 });
  writeFileSync(join(home, ".dure", "accounts", "claude-solo", ".dure-profile-generation-v1"),
    "credential-v2-solo");
  const result = { schemaVersion: 1, policy: null, profiles: [
    claudeProfile("acc-solo", "credential-v2-solo"), claudeProfile("acc-work", "credential-v2-work")] };
  const command = accountsCommand({ result, home, environment, args: ["--json"] });
  assert.equal(await command.run(), true);
  assert.deepEqual(JSON.parse(command.output[0]).registeredAccounts.map(({ referenceId, profileName, usage }) =>
    ({ referenceId, profileName, usage })), [
    // A marker without its terminating newline is incomplete.
    { referenceId: "acc-solo", profileName: null, usage: null },
    // Two directories claiming one generation are ambiguous.
    { referenceId: "acc-work", profileName: null, usage: null },
  ]);
});

test("a Claude login without credentials is listed as signed out with how to sign in again", async () => {
  const { home, environment } = localAccountsFixture({
    profiles: { "claude-file": "credential-v2-file", "claude-keychain": "credential-v2-keychain",
      "claude-out": "credential-v2-out", "claude-locked": "credential-v2-locked",
      "claude-empty": "credential-v2-empty" },
    credentials: { "claude-file": "{}", "claude-empty": "" },
    // The cache outlives the sign-out; it must not read as quota to spend.
    usage: { "claude-out": { captured_at: seconds(NOW - 3 * HOUR), rate_limits: {
      seven_day: { used_percentage: 12, resets_at: seconds(NOW + 30 * HOUR) } } } },
  });
  const accountsRoot = join(home, ".dure", "accounts");
  // The backend launches Claude with the profile's real path, so Claude Code
  // keys that run's Keychain item by it.
  const service = (directory) => claudeKeychainService(realpathSync(join(accountsRoot, directory)));
  const keychain = new Map([[service("claude-keychain"), "present"], [service("claude-locked"), "unknown"]]);
  const lookups = [];
  const keychainLookup = async (name) => { lookups.push(name); return keychain.get(name) ?? "absent"; };
  const result = { schemaVersion: 1, policy: null, profiles: [
    claudeProfile("acc-file", "credential-v2-file"), claudeProfile("acc-keychain", "credential-v2-keychain"),
    claudeProfile("acc-out", "credential-v2-out"), claudeProfile("acc-locked", "credential-v2-locked"),
    claudeProfile("acc-empty", "credential-v2-empty"), claudeProfile("acc-unmatched", "credential-v2-elsewhere"),
  ] };
  const human = accountsCommand({ result, home, environment, platform: "darwin", keychainLookup });
  assert.equal(await human.run(), true);
  assert.equal(human.output.join("\n"), [
    "claude accounts on backend local (automatic recovery: not configured)",
    "  acc-file       claude-file      usage unknown",
    "  acc-keychain   claude-keychain  usage unknown",
    "  acc-out        claude-out       signed out · weekly 12% (resets in 1d 6h) · observed 3h ago",
    "  acc-locked     claude-locked    usage unknown",
    "  acc-empty      claude-empty     usage unknown",
    "  acc-unmatched  name unknown     usage unknown",
    "A signed-out login stops at the provider's sign-in screen. Sign it in on this computer first:",
    "  CLAUDE_CONFIG_DIR=~/.dure/accounts/claude-out claude auth login",
    "Switch with: dure runs switch-account RUN --account ID. Any ID of one login selects the same credential.",
    "Use the provider's default login, which needs no registration: dure runs switch-account RUN --account default --confirm-restart",
    "Add a login signed in on this backend's host: dure accounts register claude --dir NAME --backend local (see dure accounts help)",
  ].join("\n"));
  // A credential file answers without reading the Keychain.
  assert.deepEqual(lookups.sort(), ["claude-keychain", "claude-out", "claude-locked", "claude-empty"]
    .map(service).sort());

  const json = accountsCommand({ result, home, environment, args: ["--json"], platform: "darwin", keychainLookup });
  assert.equal(await json.run(), true);
  assert.deepEqual(JSON.parse(json.output[0]).registeredAccounts.map(({ referenceId, signedIn }) =>
    ({ referenceId, signedIn })), [
    { referenceId: "acc-file", signedIn: true },
    { referenceId: "acc-keychain", signedIn: true },
    { referenceId: "acc-out", signedIn: false },
    // Only a confirmed absence is signed out.
    { referenceId: "acc-locked", signedIn: null },
    { referenceId: "acc-empty", signedIn: null },
    { referenceId: "acc-unmatched", signedIn: null },
  ]);
});

test("outside macOS a Claude login is its profile's credential file", async () => {
  const { home, environment } = localAccountsFixture({
    profiles: { "claude-work": "credential-v2-work", "claude-out": "credential-v2-out" },
    credentials: { "claude-work": "{}" },
  });
  const result = { schemaVersion: 1, policy: null, profiles: [
    claudeProfile("acc-work", "credential-v2-work"), claudeProfile("acc-out", "credential-v2-out")] };
  const command = accountsCommand({ result, home, environment });
  assert.equal(await command.run(), true);
  assert.deepEqual(command.output.join("\n").split("\n").slice(1, 5), [
    "  acc-work  claude-work  usage unknown",
    "  acc-out   claude-out   signed out · usage unknown",
    "A signed-out login stops at the provider's sign-in screen. Sign it in on this computer first:",
    "  CLAUDE_CONFIG_DIR=~/.dure/accounts/claude-out claude auth login",
  ]);
  // A Dure home outside HOME is named by its full path.
  const moved = localAccountsFixture({ profiles: { "claude-out": "credential-v2-out" } });
  const outside = accountsCommand({ result, home: join(moved.home, "user"),
    environment: { DURE_HOME: join(moved.home, ".dure") } });
  assert.equal(await outside.run(), true);
  assert.ok(outside.output.join("\n").includes(
    `  CLAUDE_CONFIG_DIR=${join(moved.home, ".dure", "accounts", "claude-out")} claude auth login`));
});

test("the Keychain item is named by the config directory's hash as Claude Code names it", () => {
  // The same vector the app's native login check pins.
  assert.equal(claudeKeychainService("/tmp/claude-work"), "Claude Code-credentials-bfc1769a");
});

test("a stored Claude credential that Claude Code does not log in with is signed out", async () => {
  const { home, environment } = localAccountsFixture({
    profiles: { "claude-stale": "credential-v2-stale", "claude-good": "credential-v2-good",
      "claude-silent": "credential-v2-silent", "claude-locked": "credential-v2-locked",
      "claude-unlocked": "credential-v2-unlocked", "claude-out": "credential-v2-out" },
    credentials: { "claude-good": "{}", "claude-silent": "{}" },
  });
  const accountsRoot = join(home, ".dure", "accounts");
  const launch = (directory) => realpathSync(join(accountsRoot, directory));
  // The reported account: its Keychain item outlived its login.
  const keychain = new Map([[claudeKeychainService(launch("claude-stale")), "present"],
    [claudeKeychainService(launch("claude-locked")), "unknown"],
    [claudeKeychainService(launch("claude-unlocked")), "unknown"]]);
  const keychainLookup = async (name) => keychain.get(name) ?? "absent";
  const answers = new Map([[launch("claude-stale"), false], [launch("claude-good"), true],
    [launch("claude-locked"), false], [launch("claude-unlocked"), true]]);
  const asked = [];
  const authStatus = async (request) => {
    asked.push(request);
    if (request.configDirectory === launch("claude-silent")) throw new Error("no answer");
    return answers.get(request.configDirectory);
  };
  const result = { schemaVersion: 1, policy: null, profiles: [
    claudeProfile("acc-stale", "credential-v2-stale"), claudeProfile("acc-good", "credential-v2-good"),
    claudeProfile("acc-silent", "credential-v2-silent"), claudeProfile("acc-locked", "credential-v2-locked"),
    claudeProfile("acc-unlocked", "credential-v2-unlocked"), claudeProfile("acc-out", "credential-v2-out"),
  ] };
  const json = accountsCommand({ result, home, environment, args: ["--json"], platform: "darwin",
    keychainLookup, authStatus });
  assert.equal(await json.run(), true);
  assert.deepEqual(JSON.parse(json.output[0]).registeredAccounts.map(({ referenceId, signedIn }) =>
    ({ referenceId, signedIn })), [
    { referenceId: "acc-stale", signedIn: false },
    { referenceId: "acc-good", signedIn: true },
    // Without an answer the stored credential decides.
    { referenceId: "acc-silent", signedIn: true },
    // An unreadable store can be why Claude Code finds no login; only its
    // "logged in" settles an unknown store.
    { referenceId: "acc-locked", signedIn: null },
    { referenceId: "acc-unlocked", signedIn: true },
    { referenceId: "acc-out", signedIn: false },
  ]);
  // Claude Code is asked about the directory the backend launches with, in
  // this command's environment and at its clock; a confirmed absence needs
  // no question.
  assert.deepEqual(asked.map(({ configDirectory }) => configDirectory).sort(),
    ["claude-good", "claude-locked", "claude-silent", "claude-stale", "claude-unlocked"].map(launch).sort());
  assert.ok(asked.every((request) => request.environment === environment && request.nowMs === NOW));

  const human = accountsCommand({ result, home, environment, platform: "darwin", keychainLookup, authStatus });
  assert.equal(await human.run(), true);
  const lines = human.output.join("\n").split("\n");
  assert.equal(lines[1], "  acc-stale     claude-stale     signed out · usage unknown");
  assert.deepEqual(lines.slice(7, 10), [
    "A signed-out login stops at the provider's sign-in screen. Sign it in on this computer first:",
    "  CLAUDE_CONFIG_DIR=~/.dure/accounts/claude-stale claude auth login",
    "  CLAUDE_CONFIG_DIR=~/.dure/accounts/claude-out claude auth login",
  ]);
});

/** A runner that answers `claude auth status --json` with one fixed result. */
function authStatusRun(result) {
  const calls = [];
  return { calls, run: async (argv, options) => { calls.push({ argv, options }); return result; } };
}

test("Claude Code's auth status is read with the environment a launch on the profile gets", async () => {
  const environment = { HOME: "/home/person", PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/elsewhere",
    ANTHROPIC_CONFIG_DIR: "/elsewhere", CLAUDE_CODE_OAUTH_TOKEN: "ambient-token",
    ANTHROPIC_API_KEY: "ambient-key", CLAUDE_CODE_USE_BEDROCK: "1" };
  const { calls, run } = authStatusRun({ kind: "success", stdout: '{"loggedIn":true}', stderr: "" });
  assert.equal(await claudeAuthStatus({ configDirectory: "/accounts/claude-work", environment,
    nowMs: NOW, run }), true);
  assert.deepEqual(calls[0].argv, ["claude", "auth", "status", "--json"]);
  assert.deepEqual(calls[0].options.env, { HOME: "/home/person", PATH: "/usr/bin",
    CLAUDE_CONFIG_DIR: "/accounts/claude-work", ANTHROPIC_CONFIG_DIR: "/accounts/claude-work" });
  assert.ok(Number.isFinite(calls[0].options.timeoutMs));
  // The caller's environment is not changed.
  assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, "ambient-token");
});

test("Claude Code's auth status reads a missing or timed-out login as signed out", async () => {
  const status = (result) => claudeAuthStatus({ configDirectory: "/accounts/claude-work",
    environment: {}, nowMs: NOW, run: authStatusRun(result).run });
  const answer = (value, code) => code === undefined
    ? { kind: "success", stdout: JSON.stringify(value), stderr: "" }
    : { kind: "nonzero", code, stdout: JSON.stringify(value), stderr: "" };
  // Claude Code exits 1 when it is not logged in.
  assert.equal(await status(answer({ loggedIn: false, authMethod: "none" }, 1)), false);
  assert.equal(await status(answer({ loggedIn: true, loginExpiresAt: null })), true);
  assert.equal(await status(answer({ loggedIn: true,
    loginExpiresAt: new Date(NOW + 2 * HOUR).toISOString() })), true);
  // Past its refresh token's end the login cannot be renewed.
  assert.equal(await status(answer({ loggedIn: true,
    loginExpiresAt: new Date(NOW - MINUTE).toISOString() })), false);
  assert.equal(await status(answer({ loggedIn: true, loginExpiresAt: "not a date" })), true);
  // Anything else is no answer.
  for (const result of [
    answer({ loggedIn: false }, 2),
    answer({ authMethod: "none" }),
    answer(null),
    { kind: "success", stdout: "Not logged in. Run claude auth login to authenticate.", stderr: "" },
    { kind: "timeout", stdout: "", stderr: "" },
    { kind: "unavailable", stdout: "", stderr: "" },
    { kind: "nonzero", signal: "SIGKILL", stdout: "", stderr: "" },
  ]) assert.equal(await status(result), undefined);
});

test.skipIf(process.platform === "win32")("the Claude Code on PATH answers for the profile directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "dure-claude-auth-status-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Logged in only for claude-in, and only when the ambient selectors were removed.
  writeFileSync(join(bin, "claude"), [
    "#!/bin/sh",
    '[ "$*" = "auth status --json" ] || exit 9',
    'if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ "$ANTHROPIC_CONFIG_DIR" != "$CLAUDE_CONFIG_DIR" ]; then',
    "  echo '{\"loggedIn\":true}'; exit 0",
    "fi",
    'case "$CLAUDE_CONFIG_DIR" in */claude-in) echo \'{"loggedIn":true}\'; exit 0;; esac',
    "echo '{\"loggedIn\":false,\"authMethod\":\"none\"}'",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });
  const environment = { PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
    CLAUDE_CODE_OAUTH_TOKEN: "ambient-token", CLAUDE_CONFIG_DIR: join(root, "claude-in") };
  assert.equal(await claudeAuthStatus({ configDirectory: join(root, "claude-in"), environment,
    nowMs: NOW }), true);
  assert.equal(await claudeAuthStatus({ configDirectory: join(root, "claude-out"), environment,
    nowMs: NOW }), false);
  assert.equal(await claudeAuthStatus({ configDirectory: join(root, "claude-out"),
    environment: { PATH: join(root, "empty") }, nowMs: NOW }), undefined);
});

test("the status check removes the same Claude selectors a launch removes", () => {
  const source = readFileSync("crates/dure-app/src/provider_credential_profile.rs", "utf8");
  const list = (name) => [...source.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`, "u"))[1]
    .matchAll(/"([A-Z0-9_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(CLAUDE_LAUNCH_STATE_ROOTS, list("CLAUDE_STATE_ROOTS"));
  assert.deepEqual(CLAUDE_LAUNCH_ENVIRONMENT_REMOVALS, list("CLAUDE_SELECTED_ENVIRONMENT_REMOVALS"));
});

test("an invalid backend result is printed unchanged instead of summarized", async () => {
  const result = { schemaVersion: 1, policy: null, profiles: "unavailable" };
  const command = accountsCommand({ result, home: "/nonexistent", environment: {} });
  assert.equal(await command.run(), true);
  assert.deepEqual(command.output.map((text) => JSON.parse(text)), [result]);
});

test("codex usage comes from the app's snapshot for any of the login's account IDs", async () => {
  const { home, environment } = localAccountsFixture({ profiles: { "codex-work": "credential-v2-codex" } });
  writeFileSync(join(home, ".dure", "codex-usage-snapshots.json"), JSON.stringify({ schemaVersion: 1, snapshots: [
    { credentialId: "acc-codex-old", capturedAt: seconds(NOW - 3 * HOUR), attemptedAt: seconds(NOW - 3 * HOUR),
      error: null, rateLimits: [{ limitId: "codex", limitName: null, usedPercent: 80, usedPercentWeekly: 90,
        resetsAt: seconds(NOW + HOUR), weeklyResetsAt: seconds(NOW + 50 * HOUR) }] },
    // The latest successful snapshot is retained when a later probe fails.
    { credentialId: "acc-codex-new", capturedAt: seconds(NOW - 5 * MINUTE), attemptedAt: seconds(NOW),
      error: "codex_usage_probe_failed", rateLimits: [
        { limitId: "codex-model", limitName: "Model", usedPercent: 99, usedPercentWeekly: null,
          resetsAt: null, weeklyResetsAt: null },
        { limitId: "codex", limitName: null, usedPercent: null, usedPercentWeekly: 27.5,
          resetsAt: null, weeklyResetsAt: seconds(NOW + 26 * HOUR) }] },
  ] }));
  const result = { schemaVersion: 1, policy: null, profiles: [
    { schemaVersion: 1, providerId: "codex", referenceId: "acc-codex-new", credentialGeneration: "credential-v2-codex" },
    { schemaVersion: 1, providerId: "codex", referenceId: "acc-codex-old", credentialGeneration: "credential-v2-codex" },
  ] };
  const output = [];
  assert.equal(await runRecoveryCommand(["get", "codex"], {
    resolveBackend: async () => ({ profile: { id: "local", transport: { kind: "local" } }, transportOptions: {} }),
    requestBackend: async () => ({ result }), output: (text) => output.push(text),
    environment, homeDirectory: home, now: () => NOW,
  }), true);
  assert.equal(output.join("\n").split("\n")[1],
    "  acc-codex-new  codex-work  weekly 28% (resets in 1d 2h) · observed 5m ago · " +
    "check failed <1m ago (codex_usage_probe_failed)");
});

function codexProfile(referenceId, credentialGeneration) {
  return { schemaVersion: 1, providerId: "codex", referenceId, credentialGeneration };
}

function codexWeekly(usedPercentWeekly, weeklyResetsAt, credits) {
  return [{ limitId: "codex", limitName: null, usedPercent: null, usedPercentWeekly,
    resetsAt: null, weeklyResetsAt, credits }];
}

test("codex usage explains a full weekly window that keeps working and a failed account check", async () => {
  const { home, environment } = localAccountsFixture({ profiles: {
    "codex-full": "credential-v2-full", "codex-fresh": "credential-v2-fresh",
    "codex-signed-out": "credential-v2-signed-out", "codex-failing": "credential-v2-failing" } });
  writeFileSync(join(home, ".dure", "codex-usage-snapshots.json"), JSON.stringify({ schemaVersion: 1, snapshots: [
    // Codex reports only a weekly window; purchased credits continue past it.
    { credentialId: "acc-full", capturedAt: seconds(NOW - 3 * MINUTE), attemptedAt: seconds(NOW - 3 * MINUTE),
      error: null, rateLimitResetsAvailable: 2, rateLimits: codexWeekly(100, seconds(NOW + 110 * HOUR),
        { hasCredits: true, unlimited: false, balance: "40147.9436810000" }) },
    { credentialId: "acc-fresh", capturedAt: seconds(NOW - 3 * MINUTE), attemptedAt: seconds(NOW - 3 * MINUTE),
      error: null, rateLimitResetsAvailable: 0, rateLimits: codexWeekly(1, seconds(NOW + 167 * HOUR),
        { hasCredits: false, unlimited: false, balance: "0" }) },
    // A profile that never produced a reading still reports why.
    { credentialId: "acc-signed-out", capturedAt: null, attemptedAt: seconds(NOW - 2 * MINUTE),
      error: "codex_usage_not_signed_in", rateLimits: [] },
    // A later failure keeps the last reading and says the check failed.
    { credentialId: "acc-failing", capturedAt: seconds(NOW - 3 * 24 * HOUR), attemptedAt: seconds(NOW - 2 * MINUTE),
      error: "codex_usage_unavailable", rateLimitResetsAvailable: 1,
      rateLimits: codexWeekly(0, seconds(NOW + 4 * 24 * HOUR), { hasCredits: true, unlimited: true, balance: null }) },
  ] }));
  const result = { schemaVersion: 1, policy: null, profiles: [
    codexProfile("acc-full", "credential-v2-full"), codexProfile("acc-fresh", "credential-v2-fresh"),
    codexProfile("acc-signed-out", "credential-v2-signed-out"), codexProfile("acc-failing", "credential-v2-failing"),
  ] };
  const run = (args) => {
    const output = [];
    return runRecoveryCommand(["get", "codex", ...args], {
      resolveBackend: async () => ({ profile: { id: "local", transport: { kind: "local" } }, transportOptions: {} }),
      requestBackend: async () => ({ result }), output: (text) => output.push(text),
      environment, homeDirectory: home, now: () => NOW,
    }).then((ok) => { assert.equal(ok, true); return output.join("\n"); });
  };
  assert.deepEqual((await run([])).split("\n").slice(1, 5), [
    "  acc-full        codex-full        weekly 100% (resets in 4d 14h) · credits 40,147.94 · usage resets 2 · observed 3m ago",
    "  acc-fresh       codex-fresh       weekly 1% (resets in 6d 23h) · observed 3m ago",
    "  acc-signed-out  codex-signed-out  usage unknown · check failed 2m ago (not signed in)",
    "  acc-failing     codex-failing     weekly 0% (resets in 4d) · unlimited credits · usage resets 1 · observed 3d ago · " +
      "check failed 2m ago (codex_usage_unavailable)",
  ]);
  const usage = JSON.parse(await run(["--json"])).registeredAccounts.map((account) => account.usage);
  assert.deepEqual(usage[0], { fiveHour: null,
    weekly: { usedPercent: 100, resetsAtMs: seconds(NOW + 110 * HOUR) * 1000 },
    observedAtMs: seconds(NOW - 3 * MINUTE) * 1000, credits: { unlimited: false, balance: 40147.943681 },
    usageResetsAvailable: 2, lastCheck: { checkedAtMs: seconds(NOW - 3 * MINUTE) * 1000, error: null } });
  assert.deepEqual(usage[2], { fiveHour: null, weekly: null, observedAtMs: null, credits: null,
    usageResetsAvailable: null, lastCheck: { checkedAtMs: seconds(NOW - 2 * MINUTE) * 1000,
      error: "codex_usage_not_signed_in" } });
});
