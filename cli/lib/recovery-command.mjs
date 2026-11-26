import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  backendTransportErrorReport,
  performBackendProfileRequest,
} from "./backend-transport.mjs";
import {
  claudeAuthStatus,
  findKeychainItem,
  formatRegisteredAccounts,
  summarizeRegisteredAccounts,
} from "./recovery-accounts.mjs";

export const RECOVERY_HELP = `dure recovery — automatic account recovery on the owning backend (Beta)

  dure recovery get PROVIDER [--backend ID] [--json]
  dure recovery put PROVIDER --enabled true|false --accounts JSON
                            --expected-revision N [--continue-after-reset true|false]
                            [--idempotency-key KEY] [--backend ID]
  dure recovery status AGENT_ID [--backend ID]
  dure recovery observe --observations JSON [--backend ID]

get lists each registered login once with its account IDs, its policy name,
and, for the local backend, its profile directory, "signed out" when that
directory holds no usable Claude login (none stored, or claude auth status
reports it logged out or past its time limit) with the command that signs it
in again, and the usage the app last observed: each limit window the provider
reports, with its reset time (unknown until observed). For Codex it adds the
credit balance, available usage resets and a failed latest check. The app
checks each Codex account about every 15 minutes while it runs, so a reading
can trail recent work, and an account past its window can keep working while
it has credits.
IDs registered for the same login select the same credential. get --json
returns the policy, the registered profile handles and this summary as
registeredAccounts, where signedIn is true, false (signed out) or null (not
known).
Other results are JSON. accounts is an ordered array of {profile, name}; copy
exact profiles from get --json.
Use revision 0 for a new policy. Only explicitly allowed accounts are used.
--continue-after-reset true (off unless given, so each put states it): when no
allowed account is available and the provider reported when its limit resets,
the backend continues the same request once, a few minutes after the reset.
A Chat agent uses the reset its failed turn reported (Claude); a terminal agent
uses the reset its login's usage meter last recorded and gets one prompt to
continue in the same terminal. If the limit still applies, recovery stops.
status then shows resumeAtMs for a Chat agent.
Joining a workspace does not register or offer personal accounts. Unknown usage
is eligible; optional observations contain {profile, usedPercent, observedAtMs}.
Before switching, the backend also reads the usage the app last observed on
its host. An attempt skips a login the app or the provider reports signed out
(or past its time limit), a login that signs in as the same provider account as
the agent's current login, and a target that fails to start, then tries the
next allowed account; each account is tried at most once per attempt.
A failed or uncertain attempt is retained. Reading status never resends work.
For a manual same-conversation account change (Claude or Codex), use
dure runs switch-account <name-or-id> --account ACCOUNT_ID; see dure runs --help.
The provider's default login on the backend needs no registration:
dure runs switch-account RUN --account default --confirm-restart.
Add a login signed in on the backend host with dure accounts register; see
dure accounts help.
Automatic recovery is opt-in and may require Dure Pro; a manual switch does not enable it.`;

export function parseRecoveryCommand(args) {
  const [action, ...rest] = args;
  if (!action || ["help", "--help", "-h"].includes(action))
    return { action: "help" };
  if (!["get", "put", "status", "observe"].includes(action))
    throw new Error(RECOVERY_HELP);
  const target = action === "observe" ? undefined : rest.shift();
  if (action !== "observe" && (!target || target.startsWith("--")))
    throw new Error(RECOVERY_HELP);
  const options = {};
  let json = false;
  const allowed = [
    "--backend",
    ...(action === "put"
      ? ["--enabled", "--accounts", "--expected-revision", "--idempotency-key",
        "--continue-after-reset"]
      : []),
    ...(action === "observe" ? ["--observations"] : []),
  ];
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === "--json") {
      json = true;
      index -= 1;
      continue;
    }
    if (!allowed.includes(flag) || Object.hasOwn(options, flag) ||
        rest[index + 1] === undefined) throw new Error(RECOVERY_HELP);
    options[flag] = rest[index + 1];
  }
  let body;
  if (action === "put") {
    const revision = Number(options["--expected-revision"]);
    if (!["true", "false"].includes(options["--enabled"]) ||
        !["true", "false", undefined].includes(options["--continue-after-reset"]) ||
        !/^\d+$/u.test(options["--expected-revision"] ?? "") ||
        !Number.isSafeInteger(revision)) throw new Error(RECOVERY_HELP);
    const accounts = JSON.parse(options["--accounts"] ?? "null");
    if (!Array.isArray(accounts)) throw new Error(RECOVERY_HELP);
    body = {
      schemaVersion: 1, providerId: target, expectedRevision: revision,
      idempotencyKey: options["--idempotency-key"] ?? `recovery-${randomUUID()}`,
      enabled: options["--enabled"] === "true", accounts,
      // Sent only when on, so a backend that predates it accepts the rest.
      ...(options["--continue-after-reset"] === "true" ? { continueAfterReset: true } : {}),
    };
  } else if (action === "observe") {
    const observations = JSON.parse(options["--observations"] ?? "null");
    if (!Array.isArray(observations)) throw new Error(RECOVERY_HELP);
    body = { schemaVersion: 1, observations };
  } else {
    body = { schemaVersion: 1,
      ...(action === "get" ? { providerId: target } : { agentId: target }) };
  }
  return {
    action, backend: options["--backend"], body, json,
    operation: action === "status" ? "agent_recovery.read"
      : `provider_recovery.${action === "observe" ? "observe_usage" : action}`,
    requiredCapabilities: ["account_recovery.v1",
      ...(body.continueAfterReset ? ["account_recovery.continue_after_reset.v1"] : [])],
  };
}

export async function runRecoveryCommand(args, {
  resolveBackend,
  requestBackend = performBackendProfileRequest,
  output = (text) => process.stdout.write(`${text}\n`),
  environment = process.env,
  homeDirectory = homedir(),
  now = Date.now,
  platform = process.platform,
  keychainLookup = findKeychainItem,
  authStatus = claudeAuthStatus,
}) {
  const command = parseRecoveryCommand(args);
  if (command.action === "help") {
    output(RECOVERY_HELP);
    return true;
  }
  try {
    const backend = await resolveBackend({ backend: command.backend,
      backendSpecified: command.backend !== undefined });
    if (backend.error) throw backend.error;
    const response = await requestBackend(backend.profile, {
      operation: command.operation, body: command.body,
      requiredCapabilities: command.requiredCapabilities,
    }, backend.transportOptions);
    if (command.action !== "get") {
      output(JSON.stringify(response.result));
      return true;
    }
    const nowMs = now();
    const local = backend.profile.transport?.kind === "local";
    const accounts = await summarizeRegisteredAccounts({ providerId: command.body.providerId,
      result: response.result, local, environment, homeDirectory, nowMs, platform, keychainLookup,
      authStatus });
    if (!accounts) output(JSON.stringify(response.result));
    else if (command.json) output(JSON.stringify({ ...response.result, registeredAccounts: accounts }));
    else output(formatRegisteredAccounts({ providerId: command.body.providerId,
      backend: backend.profile.id, policy: response.result.policy, accounts, local, nowMs,
      environment, homeDirectory }));
    return true;
  } catch (error) {
    output(JSON.stringify({ ...backendTransportErrorReport(error),
      ...(command.action === "put" ? { idempotencyKey: command.body.idempotencyKey } : {}) }));
    return false;
  }
}
