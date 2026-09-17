import fs from "node:fs";
import { runOrchestrationInvokeFromCli } from "./orchestration-command.mjs";
import { requestOrchestration } from "./orchestration-client.mjs";
import { inspectCliIdentity } from "./runtime-diagnostics.mjs";

export const EVENT_OBSERVATION_API_VERSION =
  "dure.orchestration-event-observation/v1";
const KIND = "dure.orchestration_event_observation";
const METHOD = "events.inspect.exact-session";
const MAX_SESSION_BYTES = 16 * 1024;
const HELP = `Usage: dure orchestration events-canary --session-file PATH [--backend ID] [--after N] [--limit N] [--timeout-ms N] [--json]

Observe an existing exact session without enrolling, acknowledging, or repairing it.
The file must contain WorkflowSessionGenerationV1 from the selected session receipt.
Defaults: after=0, limit=10 (maximum 128), timeout-ms=10000 (maximum 30000).
An empty window does not certify prompt delivery or a usable pane.`;
const SESSION_KEYS = [
  "sessionId",
  "workspaceId",
  "providerId",
  "runnerPrincipal",
  "runnerInstance",
  "channelEpoch",
  "hostInstanceId",
  "terminalEpoch",
];
const RECEIPT_KEYS = [
  "schemaVersion",
  "apiVersion",
  "kind",
  "backendBuildId",
  "backendGeneration",
  "sessionIdentity",
  "dispatchId",
  "generation",
  "after",
  "nextCursor",
  "eventCount",
  "deliveryStates",
  "observation",
];
const token = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u.test(value);
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const integer = (value, minimum, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (
      ![
        "--session-file",
        "--backend",
        "--after",
        "--limit",
        "--timeout-ms",
        "--json",
      ].includes(key) ||
      Object.hasOwn(options, key)
    )
      fail("event_canary_arguments_invalid");
    if (key === "--json") {
      options[key] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--"))
      fail("event_canary_arguments_invalid");
    options[key] = value;
  }
  if (!options["--session-file"]) fail("event_canary_arguments_invalid");
  for (const [key, fallback, minimum, maximum] of [
    ["--after", 0, 0, Number.MAX_SAFE_INTEGER],
    ["--limit", 10, 1, 128],
    ["--timeout-ms", 10000, 1, 30000],
  ]) {
    if (options[key] !== undefined && !/^\d+$/u.test(options[key]))
      fail("event_canary_arguments_invalid");
    options[key] = options[key] === undefined ? fallback : Number(options[key]);
    if (!integer(options[key], minimum, maximum))
      fail("event_canary_arguments_invalid");
  }
  return options;
}

function readSession(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
    );
    if (!fs.fstatSync(descriptor).isFile())
      fail("event_canary_session_invalid");
    const buffer = Buffer.alloc(MAX_SESSION_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(
        descriptor,
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_SESSION_BYTES) fail("event_canary_session_invalid");
    const session = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      ),
    );
    if (
      !exactKeys(session, SESSION_KEYS) ||
      !SESSION_KEYS.every(
        (key) =>
          typeof session[key] === "string" &&
          session[key].length > 0 &&
          session[key].length <= 256,
      )
    )
      fail("event_canary_session_invalid");
    return session;
  } catch {
    fail("event_canary_session_invalid");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function observationReceipt(envelope, options) {
  const receipt = envelope?.receipt;
  const counts = receipt?.deliveryStates;
  if (
    envelope?.apiVersion !== "dure.orchestration/v1" ||
    envelope?.method !== METHOD ||
    !exactKeys(receipt, RECEIPT_KEYS) ||
    receipt.schemaVersion !== 1 ||
    receipt.apiVersion !== EVENT_OBSERVATION_API_VERSION ||
    receipt.kind !== KIND ||
    ![
      "backendBuildId",
      "backendGeneration",
      "sessionIdentity",
      "dispatchId",
    ].every((key) => token(receipt[key])) ||
    !integer(receipt.generation, 1) ||
    receipt.after !== options["--after"] ||
    !integer(receipt.nextCursor, receipt.after) ||
    !integer(receipt.eventCount, 0, options["--limit"]) ||
    !exactKeys(counts, ["queued", "observed", "acknowledged"]) ||
    !Object.values(counts).every((count) =>
      integer(count, 0, options["--limit"]),
    ) ||
    counts.queued + counts.observed + counts.acknowledged !==
      receipt.eventCount ||
    receipt.observation !==
      (receipt.eventCount === 0 ? "empty" : "events_available") ||
    (receipt.eventCount === 0
      ? receipt.nextCursor !== receipt.after
      : receipt.nextCursor <= receipt.after)
  )
    fail("event_canary_receipt_invalid");
  return receipt;
}

export async function runEventCanaryCommand(
  args,
  scriptPath,
  {
    environment = process.env,
    output = (text) => process.stdout.write(text),
    request = requestOrchestration,
  } = {},
) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    output(`${HELP}\n`);
    return 0;
  }
  try {
    const options = parseArguments(args);
    const session = readSession(options["--session-file"]);
    const body = {
      schemaVersion: 1,
      session,
      after: options["--after"],
      limit: options["--limit"],
    };
    const signal = AbortSignal.timeout(options["--timeout-ms"]);
    const envelope = await runOrchestrationInvokeFromCli({
      arguments_: [METHOD, JSON.stringify(body)],
      backend: options["--backend"],
      backendSpecified: options["--backend"] !== undefined,
      environment,
      output: () => {},
      request: (endpoint, payload, transportOptions) =>
        request(endpoint, payload, { ...transportOptions, signal }),
    });
    const receipt = observationReceipt(envelope, options);
    const identity = inspectCliIdentity({
      scriptPath,
      environment: { PATH: "" },
    });
    output(
      `${JSON.stringify({ ...receipt, cli: { packageVersion: identity.packageVersion, buildId: identity.buildId, installation: identity.installation } }, null, options["--json"] ? undefined : 2)}\n`,
    );
    return 0;
  } catch (error) {
    const code = token(error?.code)
      ? error.code
      : "event_canary_request_failed";
    const reasonCode = token(error?.details?.code)
      ? error.details.code
      : undefined;
    const disposition = [
      "unassigned",
      "stale_generation",
      "retry_same",
      "terminal",
    ].includes(error?.details?.disposition)
      ? error.details.disposition
      : undefined;
    output(
      `${JSON.stringify({ schemaVersion: 1, apiVersion: EVENT_OBSERVATION_API_VERSION, kind: KIND, observation: "unavailable", error: { code, reasonCode, disposition } })}\n`,
    );
    return 2;
  }
}
