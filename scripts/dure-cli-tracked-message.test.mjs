import { afterEach, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendTrackedMessage, readMessageTracking, queryTrackedMessage } from "../cli/lib/tracked-message.mjs";
import { collectWait, parseWaitArguments } from "../cli/lib/wait-command.mjs";
import { trackedSendFailureMessage } from "../cli/lib/send-command.mjs";
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

test("a deferred wake explains why no prompt was written, without implying a resend", async () => {
  const { deferredWake } = await import("../cli/lib/deferred-wake.mjs");
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
