import { afterEach, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendTrackedMessage, readMessageTracking, queryTrackedMessage } from "../cli/lib/tracked-message.mjs";
import { collectWait, parseWaitArguments } from "../cli/lib/wait-command.mjs";
import { formatDelivery, trackedSendFailureMessage } from "../cli/lib/send-command.mjs";
import { deferredWake } from "../cli/lib/deferred-wake.mjs";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const generation = { runnerPrincipal: "owner", runnerInstance: "runner", channelEpoch: "1", hostInstanceId: "host", terminalEpoch: "epoch" };
const backend = { profile: { id: "local" } };
const live = { session: { sessionId: "session", workspaceId: "workspace", provider: { id: "codex" }, liveness: { exactGeneration: true }, runtime: { sessionClass: "managed", generation } } };
const context = { target: { authority: { workspaceId: "workspace" } }, coordinatorGrant: { participant: "author" }, interactionCapability: "secret-capability", endpointFence: { endpointRef: "endpoint" } };
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-message-test-")); roots.push(root); return { environment: { DURE_HOME: root }, backend, querySession: vi.fn(async () => live) }; }

test("tracked send retains private read authority before an uncertain mutation and never retries", async () => {
  const options = fixture(); let receiptPath;
  const request = vi.fn(async (_, method) => { if (method.startsWith("dispatch.context")) return context; throw new Error("connection lost"); });
  try { await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "private message", { ...options, request }); } catch (error) { expect(error.code).toBe("message_submission_unknown"); receiptPath = error.receiptPath; }
  expect(request).toHaveBeenCalledTimes(2);
  const saved = readMessageTracking(receiptPath);
  expect(saved.query.readCapability).toBe("secret-capability");
  expect(fs.readFileSync(receiptPath, "utf8")).not.toContain("private message");
  expect(fs.statSync(receiptPath).mode & 0o077).toBe(0);
});

test("tracked send exposes only the message handle, without read capabilities", async () => {
  const result = await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", { ...fixture(), request: async (_, method) => method.startsWith("dispatch.context") ? context : { deliveries: [] } });
  expect(result.receipt.kind).toBe("durable_message");
  expect(JSON.stringify(result)).not.toContain("secret-capability");
  expect(readMessageTracking(result.receipt.receiptPath).query.interactionId).toBe(result.receipt.interactionId);
});

test("only the exact receipt and Host generation associate a wake turn", async () => {
  const tracking = { session: { ...generation, sessionId: "session", workspaceId: "workspace" }, backendId: "local", query: { interactionId: "message" } };
  const receipt = { interactionId: "message", deliveries: [{ delivery: { receiptId: "delivery" }, observedAtMs: null, acknowledgedAtMs: null }] };
  const runtime = { ...live.session.runtime, agentRuntimeState: { progress: { report: { message_turns: [{ delivery_receipt_id: "delivery", turn_id: "turn" }] } } } };
  const querySession = async () => ({ session: { ...live.session, runtime } });
  const options = { tracking, backend, request: async () => receipt, querySession };
  expect((await queryTrackedMessage(options)).receipt).toMatchObject({ observed: false, acknowledged: false, wakeTurnStarted: true });
  runtime.generation = { ...generation, terminalEpoch: "replacement" };
  expect((await queryTrackedMessage(options)).receipt).toMatchObject({ wakeTurnStarted: false, runtimeObservation: "generation_changed" });
  receipt.deliveries[0].observedAtMs = 123;
  expect((await queryTrackedMessage(options)).receipt.observed).toBe(true);
});

test("a wake turn that names the short receipt reference belongs to that delivery", async () => {
  const receiptId = "delivery-b9d71327b933c911e868b53b44d0cbee1c1c5d42d6bb4e2a541efd1f3ede9044";
  const tracking = { session: { ...generation, sessionId: "session", workspaceId: "workspace" }, backendId: "local", query: { interactionId: "message" } };
  const receipt = { interactionId: "message", deliveries: [{ delivery: { receiptId }, observedAtMs: null, acknowledgedAtMs: null }] };
  const turns = [{ delivery_receipt_id: "b9d71327b934", turn_id: "other" }];
  const runtime = { ...live.session.runtime, agentRuntimeState: { progress: { report: { message_turns: turns } } } };
  const options = { tracking, backend, request: async () => receipt, querySession: async () => ({ session: { ...live.session, runtime } }) };
  expect((await queryTrackedMessage(options)).receipt.wakeTurnStarted).toBe(false);
  turns.push({ delivery_receipt_id: "b9d71327b933", turn_id: "turn" });
  expect((await queryTrackedMessage(options)).receipt.wakeTurns).toEqual([{ delivery_receipt_id: "b9d71327b933", turn_id: "turn" }]);
});

test("message waits select one condition, time out without replay and never count an unrelated response", async () => {
  const options = parseWaitArguments(["--message", "/private/receipt.json", "--until", "observed", "--timeout", "1"]);
  let time = 0;
  const result = await collectWait(options, { backend, tracking: { query: { interactionId: "message" } }, now: () => time, pause: async ms => { time += ms; }, queryMessage: async () => ({ receipt: { observed: false, wakeTurnStarted: true } }) });
  expect(result.exitCode).toBe(124);
  expect(() => parseWaitArguments(["--message", "receipt", "--task", "task"])).toThrow();
});

test("an exited Session is refused before any backend request", async () => {
  const options = fixture();
  options.querySession = vi.fn(async () => ({ session: { ...live.session, liveness: { state: "exited", exactGeneration: true } } }));
  const request = vi.fn();
  const error = await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", { ...options, request }).catch((caught) => caught);
  expect(error).toMatchObject({ code: "dure_send_session_exited", sessionId: "session" });
  expect(error.message).toContain("Nothing was sent");
  expect(request).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(options.environment.DURE_HOME, "message-receipts"))).toBe(false);
});

test("a context lookup failure reports typed codes as unsent, without backend text", async () => {
  const options = fixture();
  const request = vi.fn(async () => { throw new BackendTransportError("backend_transport_remote_error", { details: { code: "orchestration_session_unavailable", reasonCode: "hmux_descriptor_unavailable", disposition: "retry_same" } }); });
  const error = await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", { ...options, request }).catch((caught) => caught);
  expect(error.code).toBe("dure_send_context_unavailable");
  expect(error.message).toContain("orchestration_session_unavailable: hmux_descriptor_unavailable");
  expect(error.message).toContain("Nothing was sent");
  expect(request).toHaveBeenCalledTimes(1);
});

test("a destination without an inbox names its Session and how to reach it", async () => {
  const options = fixture();
  const request = vi.fn(async () => { throw new BackendTransportError("backend_transport_remote_error", { details: { code: "orchestration_generation_conflict", reasonCode: "session_dispatch_unassigned", disposition: "terminal" } }); });
  const error = await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", { ...options, request }).catch((caught) => caught);
  expect(error.code).toBe("dure_send_context_unavailable");
  expect(error.message).toMatch(/^The message context of Session session is unavailable \(orchestration_generation_conflict: session_dispatch_unassigned\)\. Nothing was sent\. /);
  expect(error.message).toContain("no Dispatch binds its current generation");
  expect(error.message).toContain("without --track");
  expect(error.message).not.toContain("dure ls --alive");
  expect(request).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(options.environment.DURE_HOME, "message-receipts"))).toBe(false);
});

test("an older backend's bare generation conflict still names the destination Session", async () => {
  const options = fixture();
  const request = vi.fn(async () => { throw new BackendTransportError("backend_transport_remote_error", { details: { code: "orchestration_generation_conflict", disposition: "terminal" } }); });
  const error = await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", { ...options, request }).catch((caught) => caught);
  expect(error.message).toBe("The message context of Session session is unavailable (orchestration_generation_conflict). Nothing was sent; check the target with dure ls --alive.");
});

test("an exited target names Agents with similar names and the live listing", () => {
  const agent = (id, name, sessionId) => ({ id, name, project: "app", sessionId });
  const target = agent("1", "android-release", "session-1");
  const registry = { agents: [target, agent("2", "android-release-2", "session-2"), agent("3", "docs", "session-3"), agent("4", "ios-release", "session-4")] };
  const error = Object.assign(new Error("exited"), { code: "dure_send_session_exited", sessionId: "session-1" });
  const message = trackedSendFailureMessage(error, registry, target);
  expect(message).toContain("android-release has exited (Session session-1). Nothing was sent.");
  expect(message).toContain("app/android-release-2, app/ios-release");
  expect(message).not.toContain("docs");
  expect(message).toContain("dure ls --alive");
  expect(trackedSendFailureMessage(new Error("other failure"), registry, target)).toBe("other failure");
});

test("a deferred wake explains why no prompt was written, without implying a resend", () => {
  const queued = (reasonCode) => [{ wake: { state: "queued_until_next_turn", reasonCode } }];
  expect(deferredWake(queued("hmux_input_draft_pending"))).toMatchObject({ reason: "wake_deferred", wakeReasonCode: "hmux_input_draft_pending", message: expect.stringContaining("unsubmitted input at its prompt") });
  expect(deferredWake(queued("hmux_agent_prompt_runtime_changed")).message).toContain("not idle at its prompt");
  expect(deferredWake(queued("hmux_agent_prompt_runtime_changed")).message).toContain("retries the wake");
  expect(deferredWake([{ wake: { state: "triggered", effectRef: "effect" } }])).toBeNull();
  expect(deferredWake(undefined)).toBeNull();
});

test("a message wait names a draft-deferred wake when it times out", async () => {
  const options = parseWaitArguments(["--message", "/private/receipt.json", "--timeout", "1"]);
  let time = 0;
  const deliveries = [{ wake: { state: "queued_until_next_turn", reasonCode: "hmux_input_draft_pending" } }];
  const result = await collectWait(options, { backend, tracking: { query: { interactionId: "message" } }, now: () => time, pause: async ms => { time += ms; }, queryMessage: async () => ({ receipt: { observed: false, wakeTurnStarted: false, deliveries } }) });
  expect(result.exitCode).toBe(124);
  expect(result.diagnostic).toMatchObject({ reason: "wake_deferred", wakeReasonCode: "hmux_input_draft_pending" });
});

test("a tracked send names a held wake in its JSON output as in its text", () => {
  const agent = { id: "agent-1", name: "worker" };
  const deliveries = [{ wake: { state: "queued_until_next_turn", reasonCode: "hmux_input_draft_pending" } }];
  const input = { sessionId: "session", workspaceId: "workspace", receipt: { kind: "durable_message", interactionId: "message.1", receiptPath: "/private/receipt.json", delivery: "accepted", deliveries } };
  const note = deferredWake(deliveries);
  const report = JSON.parse(formatDelivery(agent, input, { json: true }));
  expect(report).toMatchObject({ apiVersion: "dure.send/v1", ok: true, receipt: input.receipt, diagnostic: note });
  expect(formatDelivery(agent, input, { json: false })).toContain(note.message);
  const woken = { ...input, receipt: { ...input.receipt, deliveries: [{ wake: { state: "triggered", effectRef: "effect" } }] } };
  expect(JSON.parse(formatDelivery(agent, woken, { json: true }))).not.toHaveProperty("diagnostic");
  expect(formatDelivery(agent, woken, { json: false })).not.toContain(note.message);
});

const refusal = (code, reasonCode, disposition = "terminal") =>
  new BackendTransportError("backend_transport_remote_error", { details: { code, ...(reasonCode ? { reasonCode } : {}), disposition } });

test("a backend refusal that stored nothing is a definite failure and leaves no receipt", async () => {
  const options = fixture();
  const request = vi.fn(async (_, method) => {
    if (method.startsWith("dispatch.context")) return context;
    if (method === "interaction.progress") throw refusal("orchestration_record_not_found");
    throw refusal("orchestration_request_invalid", "control_character");
  });
  const error = await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", { ...options, request }).catch((caught) => caught);
  expect(error.code).toBe("message_submission_refused");
  expect(error.message).toContain("orchestration_request_invalid: control_character");
  expect(error.message).toContain("Nothing was stored");
  expect(error.message).not.toContain("do not resend");
  // One open, settled by the exact read of the query it retained; never a second open.
  expect(request.mock.calls.map(([, method]) => method)).toEqual(["dispatch.context.get.exact-session", "interaction.message.open.exact-session", "interaction.progress"]);
  expect(request.mock.calls[2][2].interactionId).toBe(request.mock.calls[1][2].interactionId);
  expect(fs.readdirSync(path.join(options.environment.DURE_HOME, "message-receipts"))).toEqual([]);
});

test("a backend refusal after the message was stored reports the accepted message", async () => {
  const options = fixture();
  const delivery = { receiptId: "delivery", wake: { state: "uncertain" } };
  const request = vi.fn(async (_, method, body) => {
    if (method.startsWith("dispatch.context")) return context;
    if (method === "interaction.progress") return { interactionId: body.interactionId, deliveries: [{ delivery, observedAtMs: null, acknowledgedAtMs: null }] };
    throw refusal("orchestration_wake_receipt_missing", undefined, "retry_same");
  });
  const result = await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", { ...options, request });
  expect(result.receipt).toMatchObject({ kind: "durable_message", delivery: "accepted", deliveries: [delivery] });
  expect(readMessageTracking(result.receipt.receiptPath).query.interactionId).toBe(result.receipt.interactionId);
});

test("a refusal whose stored state cannot be read stays unknown and keeps its receipt", async () => {
  const options = fixture();
  const request = vi.fn(async (_, method) => {
    if (method.startsWith("dispatch.context")) return context;
    if (method === "interaction.progress") throw new BackendTransportError("backend_transport_timeout");
    throw refusal("orchestration_store_unavailable", "adapter_busy", "retry_same");
  });
  const error = await sendTrackedMessage({ sessionId: "session", workspaceId: "workspace" }, "hello", { ...options, request }).catch((caught) => caught);
  expect(error.code).toBe("message_submission_unknown");
  expect(error.message).toContain("orchestration_store_unavailable: adapter_busy");
  expect(readMessageTracking(error.receiptPath).backendId).toBe("local");
});

test("a message the backend never stored ends its wait as failed instead of unknown", async () => {
  const tracking = { session: { ...generation, sessionId: "session", workspaceId: "workspace" }, backendId: "local", query: { interactionId: "message" } };
  const querySession = vi.fn();
  const error = await queryTrackedMessage({ tracking, backend, querySession, request: async () => { throw refusal("orchestration_record_not_found"); } }).catch((caught) => caught);
  expect(error.code).toBe("message_not_stored");
  expect(querySession).not.toHaveBeenCalled();
  const options = parseWaitArguments(["--message", "/private/receipt.json", "--timeout", "5"]);
  const result = await collectWait(options, { backend, tracking, now: () => 0, pause: async () => {}, queryMessage: async () => { throw error; } });
  expect(result).toMatchObject({ state: "failed", exitCode: 1, error: { code: "wait_message_not_stored" } });
  expect(result.error.message).toContain("was not stored");
});
