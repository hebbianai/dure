import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { ACCOUNTS_HELP, parseAccountsCommand, runAccountsCommand } from "../cli/lib/accounts-command.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";

const registered = (providerId, referenceId) => ({ schemaVersion: 1, profile: { schemaVersion: 1,
  providerId, referenceId, credentialGeneration: "credential-v2-generation" } });
const remoteError = (code) => new BackendTransportError("backend_transport_remote_error",
  { details: { code } });

function fixture(requestBackend, backendId = "vm") {
  const output = [];
  const errors = [];
  const routes = [];
  const requests = [];
  return { output, errors, routes, requests, options: {
    resolveBackend: async (selection) => {
      routes.push(selection);
      return { profile: { id: backendId, transport: { kind: "ssh_stdio" } },
        transportOptions: { deadlineMs: 5000 } };
    },
    requestBackend: async (profile, request, transportOptions) => {
      requests.push({ profile, request, transportOptions });
      return requestBackend(request);
    },
    output: (text) => output.push(text),
    errorOutput: (text) => errors.push(text),
  } };
}

const succeeds = ({ body }) => ({ result: registered(body.providerId, body.referenceId) });

test("register sends only names to the chosen backend, with the directory as the account ID", async () => {
  const f = fixture(succeeds);
  assert.equal(await runAccountsCommand(["register", "codex", "--dir", "codex-work",
    "--backend", "vm"], f.options), true);
  assert.deepEqual(f.routes, [{ backend: "vm", backendSpecified: true }]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].profile.id, "vm");
  assert.deepEqual(f.requests[0].transportOptions, { deadlineMs: 5000 });
  assert.deepEqual(f.requests[0].request, {
    operation: "provider_credential_profile.register",
    requiredCapabilities: ["provider_credential_profile.register"],
    body: { schemaVersion: 1, providerId: "codex", referenceId: "codex-work",
      profileDirectoryName: "codex-work" },
  });
  assert.deepEqual(f.output, [[
    "Registered codex account codex-work on backend vm.",
    "Switch a Run to it: dure runs switch-account RUN --account codex-work --backend vm --confirm-restart",
  ].join("\n")]);
  assert.deepEqual(f.errors, []);
});

test("running register again repeats the same request and account ID", async () => {
  const f = fixture(succeeds);
  const args = ["register", "claude", "--dir", "claude-work", "--json"];
  assert.equal(await runAccountsCommand(args, f.options), true);
  assert.equal(await runAccountsCommand(args, f.options), true);
  assert.deepEqual(f.requests[1].request, f.requests[0].request);
  assert.deepEqual(f.output.map((text) => JSON.parse(text)), [
    registered("claude", "claude-work"), registered("claude", "claude-work"),
  ]);
});

test("without --backend the command leaves backend selection to the default", async () => {
  const f = fixture(succeeds, "local");
  assert.equal(await runAccountsCommand(["register", "codex", "--dir", "codex-work"], f.options), true);
  assert.deepEqual(f.routes, [{ backend: undefined, backendSpecified: false }]);
  assert.match(f.output[0], /on backend local\./u);
});

test("a directory that is not one provider-scoped name is refused before any backend request", async () => {
  for (const directory of ["~/.dure/accounts/codex-work", "../codex-work", "codex-", "work",
    "claude-work", "codex-w.rk", `codex-${"a".repeat(160)}`]) {
    const f = fixture(succeeds);
    await assert.rejects(runAccountsCommand(["register", "codex", "--dir", directory], f.options),
      /--dir takes one directory name/u, directory);
    assert.deepEqual(f.requests, [], directory);
  }
});

test("incomplete or unknown invocations show the command's usage", () => {
  for (const args of [["register"], ["register", "--dir", "codex-work"], ["register", "codex"],
    ["add", "codex", "--dir", "codex-work"], ["register", "codex", "--dir", "codex-a", "--dir", "codex-b"],
    ["register", "codex", "--dir", "codex-a", "--profile", "x"]]) {
    assert.throws(() => parseAccountsCommand(args), (error) => error.message === ACCOUNTS_HELP, args.join(" "));
  }
  for (const args of [[], ["help"], ["--help"], ["register", "--help"], ["register", "codex", "-h"]]) {
    assert.deepEqual(parseAccountsCommand(args), { action: "help" }, args.join(" "));
  }
});

test("a directory that is not ready says what to run on the host, for each provider", async () => {
  for (const [provider, signIn] of [
    ["codex", "CODEX_HOME=~/.dure/accounts/codex-work codex login --device-auth"],
    ["claude", "CLAUDE_CONFIG_DIR=~/.dure/accounts/claude-work claude auth login"],
  ]) {
    const f = fixture(() => { throw remoteError("provider_credential_profile_unavailable"); });
    assert.equal(await runAccountsCommand(["register", provider, "--dir", `${provider}-work`,
      "--backend", "vm"], f.options), false);
    assert.deepEqual(f.output, []);
    assert.match(f.errors[0], new RegExp(`Directory ${provider}-work is not ready on backend vm`, "u"));
    assert.ok(f.errors[0].includes(`chmod 700 ~/.dure/accounts ~/.dure/accounts/${provider}-work`));
    assert.ok(f.errors[0].includes(signIn), signIn);
  }
});

test("a directory the app already registered points at its existing account ID", async () => {
  const f = fixture(() => { throw remoteError("provider_credential_profile_conflict"); });
  assert.equal(await runAccountsCommand(["register", "codex", "--dir", "codex-app",
    "--backend", "vm"], f.options), false);
  assert.match(f.errors[0], /registered differently on backend vm/u);
  assert.ok(f.errors[0].includes("dure recovery get codex --backend vm"));
});

test("--json failures keep the backend's code and add the same guidance", async () => {
  const f = fixture(() => { throw remoteError("provider_credential_profile_conflict"); });
  assert.equal(await runAccountsCommand(["register", "codex", "--dir", "codex-app",
    "--backend", "vm", "--json"], f.options), false);
  assert.deepEqual(f.errors, []);
  const report = JSON.parse(f.output[0]);
  assert.equal(report.kind, "dure.accounts.error");
  assert.equal(report.complete, false);
  assert.equal(report.error.remoteCode, "provider_credential_profile_conflict");
  assert.equal(report.error.profileId, "vm");
  assert.match(report.error.guidance, /dure recovery get codex --backend vm/u);
});

test("a missing backend capability or an unselectable backend is reported, not guessed", async () => {
  const unsupported = fixture(() => { throw new BackendTransportError(
    "backend_transport_capability_missing", { details: { capability: "provider_credential_profile.register" } }); });
  assert.equal(await runAccountsCommand(["register", "codex", "--dir", "codex-work", "--json"],
    unsupported.options), false);
  assert.equal(JSON.parse(unsupported.output[0]).error.capability, "provider_credential_profile.register");

  const f = fixture(succeeds);
  const options = { ...f.options, resolveBackend: async () => ({ error: new Error("no such backend") }) };
  assert.equal(await runAccountsCommand(["register", "codex", "--dir", "codex-work"], options), false);
  assert.deepEqual(f.requests, []);
  assert.match(f.errors[0], /Could not register codex-work/u);
});

test("a response for a different account is refused instead of reported as registered", async () => {
  for (const result of [{}, registered("codex", "acc-other"), registered("claude", "codex-work"),
    { schemaVersion: 1, profile: { ...registered("codex", "codex-work").profile, credentialGeneration: "" } }]) {
    const f = fixture(() => ({ result }));
    assert.equal(await runAccountsCommand(["register", "codex", "--dir", "codex-work"], f.options), false);
    assert.deepEqual(f.output, []);
    assert.match(f.errors[0], /invalid account registration/u);
  }
});

test("the CLI dispatches accounts help without an app, registry or backend", () => {
  const root = mkdtempSync(join(tmpdir(), "dure-accounts-help-"));
  const cli = join(import.meta.dirname, "../cli/dure.mjs");
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), DURE_HOME: join(root, "dure"),
    HMUX_DISCOVERY_ROOT: join(root, "discovery") };
  for (const args of [["accounts", "--help"], ["help", "accounts"]]) {
    assert.equal(execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8" }).trim(), ACCOUNTS_HELP);
  }
});
