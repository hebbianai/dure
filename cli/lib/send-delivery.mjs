/**
 * How `dure send` reaches an Agent, chosen by whoever starts its Run
 * (`dure run --send-delivery inbox`) and recorded on the backend's Run record,
 * which is the only owner. Nothing changes it after the Run starts. An Agent
 * whose Runs record none takes terminal input as before.
 *
 * inbox: only the durable inbox. `dure send` opens a tracked message, refuses
 * options that exist only for terminal input and never falls back to it.
 */
import { AGENT_SPAWN_SEND_DELIVERIES, AGENT_SPAWN_SEND_DELIVERY_CAPABILITY } from "./agent-spawn-query.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { listRunRecords, sessionAgentIds } from "./run-agent-selection.mjs";

/** A selector names few Runs; more pages than this are not one Agent's. */
const MAX_RUN_PAGES = 4;

/** Profile selections that find no such backend on this machine, so no Run
 * there can have recorded a choice for the target. */
const UNCONFIGURED_BACKEND = new Set(["backend_profiles_config_missing", "backend_profiles_selection_not_found"]);

function unreadable(message, cause) {
  return Object.assign(new Error(message), { code: "dure_send_delivery_unreadable", cause });
}

/** The delivery any Run of these Agents recorded, or null when none did.
 * Throws when the backend cannot say, so a send never guesses terminal input
 * for an Agent that may have chosen the inbox. */
export async function recordedSendDelivery({ agentIds, backend, requestBackend }) {
  for (const agentId of agentIds) {
    let cursor;
    for (let page = 0; page < MAX_RUN_PAGES; page += 1) {
      const listed = await listRunRecords({ backend, requestBackend, selector: agentId, cursor });
      if (listed.error) throw unreadable(`its Run records are unavailable (${listed.error.code})`);
      for (const run of listed.page.runs) {
        if (run.agentId !== agentId || run.sendDelivery === undefined) continue;
        if (!AGENT_SPAWN_SEND_DELIVERIES.includes(run.sendDelivery)) {
          throw unreadable(`its Run records a send delivery this Dure CLI does not know (${String(run.sendDelivery).slice(0, 64)}); update Dure`);
        }
        return run.sendDelivery;
      }
      cursor = listed.page.nextCursor;
      if (cursor === null) break;
    }
    if (cursor) throw unreadable(`more than ${MAX_RUN_PAGES} pages of Run records match ${agentId}`);
  }
  return null;
}

/** The send delivery of a `dure send` target: a registered Agent, or an exact
 * Session mapped to the Agents bound to it. A backend that cannot record the
 * choice (it does not advertise the capability) has none. */
export async function sendTargetDelivery({ target, backend, requestBackend }) {
  if (UNCONFIGURED_BACKEND.has(backend?.error?.code)) return null;
  if (backend?.error || !backend?.profile) {
    throw unreadable(`its backend is unavailable (${backend?.error?.code ?? "backend_unavailable"})`, backend?.error);
  }
  if (!backend.profile.expected?.capabilities?.includes(AGENT_SPAWN_SEND_DELIVERY_CAPABILITY)) return null;
  try {
    const agentIds = typeof target === "string"
      ? await sessionAgentIds({ sessionId: target, backend, requestBackend }) ?? []
      : [target.id].filter(isDureDomainIdV1);
    return await recordedSendDelivery({ agentIds, backend, requestBackend });
  } catch (error) {
    if (error?.code === "dure_send_delivery_unreadable") throw error;
    throw unreadable(`its backend did not answer (${error?.code ?? error?.message ?? "request_failed"})`, error);
  }
}
