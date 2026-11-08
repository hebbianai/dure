import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
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
 * directories and the collector's per-profile usage cache. */
function localAccountsFixture({ profiles = {}, usage = {}, extraDirectories = [] } = {}) {
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
  const usageRoot = join(dureHome, "usage", "claude-rate-limits");
  mkdirSync(usageRoot, { recursive: true });
  for (const [directory, payload] of Object.entries(usage)) {
    writeFileSync(join(usageRoot, `${directory}.json`),
      typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  return { home, environment: { HOME: home } };
}

function accountsCommand({ result, kind = "local", home, environment, args = [] }) {
  const output = [];
  const requests = [];
  return { output, requests, run: () => runRecoveryCommand(["get", "claude", ...args], {
    resolveBackend: async () => ({ profile: { id: kind === "local" ? "local" : "shared",
      transport: { kind } }, transportOptions: {} }),
    requestBackend: async (_, request) => { requests.push(request); return { result }; },
    output: (text) => output.push(text),
    environment, homeDirectory: home, now: () => NOW,
  }) };
}

const seconds = (ms) => Math.floor(ms / 1000);

test("get lists each login once with its local profile name, usage windows and reset times", async () => {
  const { home, environment } = localAccountsFixture({
    profiles: { "claude-work": "credential-v2-work", "claude-personal": "credential-v2-personal",
      "claude-retired": "credential-v2-retired" },
    extraDirectories: ["claude-work.lock"],
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
      name: null, profileName: "claude-personal", usage: null },
    { referenceId: "acc-work-a", aliasReferenceIds: ["acc-work-b"], credentialGeneration: "credential-v2-work",
      name: null, profileName: "claude-work", usage: {
        fiveHour: { usedPercent: 42, resetsAtMs: NOW + 2 * HOUR + 10 * MINUTE },
        weekly: { usedPercent: 61.4, resetsAtMs: NOW + 99 * HOUR },
        observedAtMs: NOW - 12 * MINUTE, credits: null, usageResetsAvailable: null, lastCheck: null } },
    { referenceId: "acc-unmatched", aliasReferenceIds: [], credentialGeneration: "credential-v2-elsewhere",
      name: null, profileName: null, usage: null },
  ]);
});

test("a policy name labels its login and its ID is offered first", async () => {
  const { home, environment } = localAccountsFixture({ profiles: { "claude-work": "credential-v2-work" } });
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
      name: null, profileName: null, usage: null },
  ]);
  const human = accountsCommand({ result, kind: "ssh", home, environment });
  assert.equal(await human.run(), true);
  assert.match(human.output.join("\n"),
    /Profile names and usage are read from this computer, so they are unknown for remote backend shared\./);
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
