import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

const runtime = "__DURE_HMUX_RUNTIME_EXECUTABLE__";

// Pi owns activity; this extension only carries its events to the existing
// exact-generation Host report boundary. No provider config is rewritten.
export default function (pi) {
  const keys = ["workspace_id", "session_id", "runner_principal", "runner_instance",
    "channel_epoch", "host_instance_id", "terminal_epoch"];
  const fence = Object.fromEntries(keys.map((key) => [key, process.env[`HMUX_${key.toUpperCase()}`]]));
  if (!isAbsolute(runtime) || keys.some((key) => !fence[key])) return;

  let delivery = Promise.resolve();
  const report = (event, ctx) => {
    const working = event.type === "agent_start" || !ctx.isIdle();
    const session = ctx.sessionManager;
    const leaf = session.getLeafEntry();
    const completed = event.type === "agent_settled" && !working
      && leaf?.type === "message" && leaf.message.role === "assistant"
      && ["stop", "length"].includes(leaf.message.stopReason);
    const conversation = session.getSessionId();
    const transcript = session.getSessionFile();
    const payload = Buffer.from(JSON.stringify({
      schema: "hmux-managed-agent-state-report-v1", schemaVersion: 1,
      expectedFence: fence,
      report: {
        request_id: randomUUID(), identity_only: false,
        activity: working ? "working" : "waiting", attention: "none",
        turn_completed: completed,
        ...(working ? { working_ttl_ms: "86400000" } : {}),
        ...(completed ? { turn_completion_id: `${conversation}:${leaf.id}` } : {}),
        // Pi allocates a path before it persists a conversation. Only an
        // existing transcript can be resumed by a later managed launch.
        ...(transcript && existsSync(transcript) ? {
          conversation_identity: { provider_id: "pi", conversation_id: conversation },
        } : {}),
      },
    }));
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length);
    payload.copy(frame, 4);
    // Preserve event order even when Pi emits a notification concurrently.
    // Each report has one bounded child, with no retry or independent timer.
    delivery = delivery.then(() => new Promise((resolve) => {
      const child = execFile(runtime,
        ["--no-autostart", "internal-hmux-managed-agent-state-report"],
        { timeout: 2_000, maxBuffer: 64 * 1024 }, () => resolve());
      child.stdin.on("error", () => {});
      child.stdin.end(frame);
    }));
    return delivery;
  };
  for (const event of ["session_start", "model_select", "thinking_level_select", "agent_start", "agent_settled"]) {
    pi.on(event, report);
  }
  pi.on("session_shutdown", () => delivery);
}
