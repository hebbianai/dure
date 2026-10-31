import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  backendTransportErrorReport,
  performBackendProfileRequest,
} from "./backend-transport.mjs";
import { formatRegisteredAccounts, summarizeRegisteredAccounts } from "./recovery-accounts.mjs";

export const RECOVERY_HELP = `dure recovery — automatic account recovery on the owning backend (Beta)

  dure recovery get PROVIDER [--backend ID] [--json]
  dure recovery put PROVIDER --enabled true|false --accounts JSON
                            --expected-revision N [--idempotency-key KEY] [--backend ID]
  dure recovery status AGENT_ID [--backend ID]
  dure recovery observe --observations JSON [--backend ID]

get lists each registered login once with its account IDs, its policy name,
and, for the local backend, its profile directory and 5h/weekly usage with reset
times from the app's usage caches (unknown until observed). IDs registered for
the same login select the same credential. get --json returns the policy, the
registered profile handles and this summary as registeredAccounts.
Other results are JSON. accounts is an ordered array of {profile, name}; copy
exact profiles from get --json.
Use revision 0 for a new policy. Only explicitly allowed accounts are used.
Joining a workspace does not register or offer personal accounts. Unknown usage
is eligible; optional observations contain {profile, usedPercent, observedAtMs}.
A failed or uncertain attempt is retained. Reading status never resends work.
For a manual same-conversation account change (Claude or Codex), use
dure runs switch-account <name-or-id> --account ACCOUNT_ID; see dure runs --help.
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
      ? ["--enabled", "--accounts", "--expected-revision", "--idempotency-key"]
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
        !/^\d+$/u.test(options["--expected-revision"] ?? "") ||
        !Number.isSafeInteger(revision)) throw new Error(RECOVERY_HELP);
    const accounts = JSON.parse(options["--accounts"] ?? "null");
    if (!Array.isArray(accounts)) throw new Error(RECOVERY_HELP);
    body = {
      schemaVersion: 1, providerId: target, expectedRevision: revision,
      idempotencyKey: options["--idempotency-key"] ?? `recovery-${randomUUID()}`,
      enabled: options["--enabled"] === "true", accounts,
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
  };
}

export async function runRecoveryCommand(args, {
  resolveBackend,
  requestBackend = performBackendProfileRequest,
  output = (text) => process.stdout.write(`${text}\n`),
  environment = process.env,
  homeDirectory = homedir(),
  now = Date.now,
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
      requiredCapabilities: ["account_recovery.v1"],
    }, backend.transportOptions);
    if (command.action !== "get") {
      output(JSON.stringify(response.result));
      return true;
    }
    const nowMs = now();
    const local = backend.profile.transport?.kind === "local";
    const accounts = summarizeRegisteredAccounts({ providerId: command.body.providerId,
      result: response.result, local, environment, homeDirectory, nowMs });
    if (!accounts) output(JSON.stringify(response.result));
    else if (command.json) output(JSON.stringify({ ...response.result, registeredAccounts: accounts }));
    else output(formatRegisteredAccounts({ providerId: command.body.providerId,
      backend: backend.profile.id, policy: response.result.policy, accounts, local, nowMs }));
    return true;
  } catch (error) {
    output(JSON.stringify({ ...backendTransportErrorReport(error),
      ...(command.action === "put" ? { idempotencyKey: command.body.idempotencyKey } : {}) }));
    return false;
  }
}
