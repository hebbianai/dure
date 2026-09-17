import { createHash } from "node:crypto";
import { collectSessionQuery } from "./session-query.mjs";
import { boundedString, GENERATION_FIELDS, sameGeneration } from "./session-runtime-projection.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

const fields = [
  ["sessionId", "HMUX_SESSION_ID"], ["workspaceId", "HMUX_WORKSPACE_ID"],
  ...GENERATION_FIELDS.map(([projected, wire]) => [projected, `HMUX_${wire.toUpperCase()}`]),
];
const resourceFields = ["resource_id", "generation", "workspace_id"];
const sameResource = (left, right) => resourceFields.every((key) => left?.[key] === right?.[key]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const positive = (value) => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;

export function implicitBrowserSessionController(options, environment) {
  return options.controller === undefined && options.epoch === undefined
    && fields.some(([, key]) => environment?.[key] !== undefined);
}

/** Environment values are lookup hints. Only the selected authenticated backend
 * verifies the live generation; its existing permissions still authorize access. */
export async function resolveBrowserSessionController(environment, backend, requestBackend) {
  const hint = Object.fromEntries(fields.map(([field, key]) => [field, environment?.[key]]));
  if (!fields.every(([field]) => boundedString(hint[field], 256))) throw new Error("browser_session_context_invalid");
  const report = await collectSessionQuery({ action: "show", sessionId: hint.sessionId,
    workspaceId: hint.workspaceId, backend, requestBackend });
  const session = report.session;
  if (report.complete !== true || report.partial !== false || session?.liveness?.state !== "alive"
      || session.liveness.health !== "healthy" || session.liveness.exactGeneration !== true
      || session.liveness.manifestLifecycle !== "ready" || session.liveness.effectiveLifecycle !== "ready"
      || session.runtime?.source !== "hmux_host") throw new Error("browser_session_unavailable");
  if (session.sessionId !== hint.sessionId || session.workspaceId !== hint.workspaceId
      || !sameGeneration(session.runtime.generation, hint)) throw new Error("browser_session_changed");
  return { controller_id: `session-v1:${digest(fields.map(([field]) => hint[field]))}`,
    session_id: session.sessionId, workspace_id: session.workspaceId, generation: session.runtime.generation };
}

function validControl(control, resourceId) {
  if (!control || control.resource?.resource_id !== resourceId
      || !resourceFields.every((key) => isDureDomainIdV1(control.resource[key]))
      || (control.controller !== null && (!control.controller || !sameResource(control.controller.resource, control.resource)
        || !isDureDomainIdV1(control.controller.controller_id) || !positive(control.controller.epoch)))) {
    throw new Error("browser_response_invalid");
  }
  return control;
}

/** Consume Host control state once. Implicit commands never take another owner's
 * lease, retry a handoff, or keep authority across CLI invocations. */
export async function prepareBrowserSessionControl(request, resourceId, source, operationId, { snapshot = false } = {}) {
  const control = validControl((await request({ kind: "control_state", resource_id: resourceId }))?.result, resourceId);
  if (snapshot && control.controller?.controller_id !== source.controller_id && control.controller !== null) {
    return { resource: control.resource };
  }
  if (control.phase !== "ready" || control.requested_controller != null) throw new Error("browser_controller_changed");
  if (control.controller !== null) {
    if (control.controller.controller_id !== source.controller_id) throw new Error("browser_controller_changed");
    return { resource: control.resource, lease: control.controller };
  }
  // Publish the separate recovery ID before sending. A lost control response must
  // not masquerade as an input failure whose operation can simply be resubmitted.
  source.control_operation_id = `control-v1:${digest([operationId, control.resource.resource_id,
    control.resource.generation, control.resource.workspace_id, source.controller_id])}`;
  const result = await request({ kind: "control", resource: control.resource, controller_id: source.controller_id,
    expected: null, operation_id: source.control_operation_id });
  const granted = validControl(result?.result, resourceId);
  if ((result.replayed && result.receipt?.state !== "succeeded") || !sameResource(granted.resource, control.resource)
      || granted.phase !== "ready" || granted.requested_controller != null
      || granted.controller?.controller_id !== source.controller_id) throw new Error("browser_controller_changed");
  return { resource: control.resource, lease: granted.controller };
}
