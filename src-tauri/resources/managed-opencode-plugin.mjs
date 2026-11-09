import { randomUUID } from "node:crypto";
import { sendManagedReport } from "./managed-hook-report.mjs";
import {
  applyOpenCodeEvent, claimOpenCodeReporter, createOpenCodeActivity, managedFence, nextOpenCodeReport,
} from "./managed-opencode-state.mjs";

const runtime = "__DURE_HMUX_RUNTIME_EXECUTABLE__";
// OpenCode re-creates its plugins when an instance reloads, sometimes in the
// middle of a turn, so what is already known must outlive one plugin object.
const processActivity = Symbol.for("dure.opencode.activity.v1");

// OpenCode calls every function exported here, so export only the plugin.
export const DureOpenCodeActivity = async ({ client } = {}) => {
  const fence = managedFence(process.env);
  if (!fence || !claimOpenCodeReporter(process.env, process.pid)) return {};
  const shared = (globalThis[processActivity] ??= { state: createOpenCodeActivity(), delivery: Promise.resolve() });
  const publish = (completed) => {
    const report = nextOpenCodeReport(shared.state, fence, completed, randomUUID());
    if (!report) return;
    // Reports reach the Host in the order the events happened.
    shared.delivery = shared.delivery.then(() => sendManagedReport(runtime, report)).catch((error) => {
      // A terminal UI owns stdout and stderr; OpenCode's own log is the channel.
      Promise.resolve(client?.app?.log?.({ body: { service: "dure-activity", level: "warn", message: String(error?.message ?? error) } }))
        .catch(() => {});
    });
  };
  publish(false);
  return { event: async ({ event }) => publish(applyOpenCodeEvent(shared.state, event)) };
};
