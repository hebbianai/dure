import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { resolveBackendProfilesPath } from "./backend-profiles.mjs";
import { browserActionAuthority, browserControllerAuthority, browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";
import { downloadBrowserArtifact } from "./browser-artifact.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

export function browserTracing(mode, values, options, implicitController = false) {
  const [action, path] = values;
  if (!["start", "stop", "status"].includes(action) || values.length > (action === "stop" ? 2 : 1)) throw new Error("browser_trace_command_invalid");
  if (action !== "status" && !implicitController && (!options.controller || !options.epoch)) throw new Error("browser_controller_required");
  if (options.tracingRecording !== undefined && (action === "start" || options.page !== undefined || !isDureDomainIdV1(options.tracingRecording))) throw new Error("browser_trace_recording_invalid");
  if (action !== "start" && (options.scope !== undefined || options.categories !== undefined)) throw new Error("browser_trace_command_invalid");
  if (options.scope !== undefined && !["task", "browser"].includes(options.scope)) throw new Error("browser_trace_scope_invalid");
  if (options.categories !== undefined && (mode !== "profiler" || action !== "start")) throw new Error("browser_trace_categories_invalid");
  const categories = options.categories?.split(",").map((value) => value.trim());
  if (categories && (categories.length > 256 || categories.some((value) => !value || Buffer.byteLength(value) > 256 || value.includes("\0")))) throw new Error("browser_trace_categories_invalid");
  if ((path !== undefined && options.output !== undefined) || (action !== "stop" && options.output !== undefined)) throw new Error("browser_trace_output_invalid");
  const output = path ?? options.output;
  if (output !== undefined && (!output || Buffer.byteLength(output) > 4096 || output.includes("\0"))) throw new Error("browser_trace_output_invalid");
  return { action, mode, scope: options.scope ?? "task", categories, output, recording: options.tracingRecording };
}

function interval(value, resource) {
  if (!value || !isDureDomainIdV1(value.operation_id) || !["trace", "profiler"].includes(value.mode)
      || !["task", "browser"].includes(value.scope) || !["starting", "recording", "finished"].includes(value.phase)
      || (value.cleanup_confirmed !== null && typeof value.cleanup_confirmed !== "boolean")
      || ["resource_id", "generation", "workspace_id"].some((key) => value.resource?.[key] !== resource[key])) throw new Error("browser_response_invalid");
  browserCurrentPage({ resource, current_page: value.origin });
  return value;
}

function instance(value, resource) {
  if (!value || !isDureDomainIdV1(value.instance_id) || typeof value.busy !== "boolean"
      || ["resource_id", "generation", "workspace_id"].some((key) => value.resource?.[key] !== resource[key])
      || (value.interval !== null && !value.busy)) throw new Error("browser_response_invalid");
  if (value.interval !== null) interval(value.interval, resource);
  return value;
}

async function destination(tracing, operation, local) {
  if (tracing.output !== undefined) return resolve(local.cwd ?? process.cwd(), tracing.output);
  const root = join(dirname(resolveBackendProfilesPath({ environment: local.environment })), "browser-traces");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("browser_trace_output_unsafe");
  const key = createHash("sha256").update(JSON.stringify([local.profile.id, local.profile.expected, operation])).digest("hex");
  return join(root, `${tracing.mode}-${key}.json`);
}

export async function performBrowserTracing(request, resourceId, tracing, options, operationId, local) {
  const progress = { operation_id: operationId };
  try {
    const control = (await request({ kind: "control_state", resource_id: resourceId })).result;
    if (control?.resource?.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
    let page;
    let selected;
    if (tracing.action === "start" || options.page !== undefined) {
      const current = options.page === undefined ? browserCurrentPage(control) : undefined;
      const pageId = options.page ?? current.page_id;
      const observed = await request({ kind: "tracing_state", resource: control.resource, page_id: pageId });
      selected = instance(observed?.result, control.resource);
      page = selected.page;
      browserCurrentPage({ resource: control.resource, current_page: page });
      if (page.page_id !== pageId || (current && !sameBrowserPage(current, page))) throw new Error("browser_response_invalid");
    }
    let active;
    let requestBody;
    if (tracing.action === "start") {
      requestBody = { kind: "action", caller: options.controller,
        authority: browserActionAuthority(control, page, options, operationId),
        action: { kind: "tracing", action: { kind: "start", mode: tracing.mode, scope: tracing.scope,
          ...(tracing.categories === undefined ? {} : { categories: tracing.categories }) } } };
    } else {
      const observed = await request({ kind: "tracing_intervals", resource: control.resource });
      if (!Array.isArray(observed?.result?.instances)
          || ["resource_id", "generation", "workspace_id"].some((key) => observed.result.resource?.[key] !== control.resource[key])) throw new Error("browser_response_invalid");
      const all = observed.result.instances.map((value) => instance(value, control.resource));
      if (new Set(all.map((value) => value.instance_id)).size !== all.length) throw new Error("browser_response_invalid");
      const instances = selected ? all.filter((value) => value.instance_id === selected.instance_id) : all;
      const owned = instances.filter((value) => value.interval && (tracing.recording === undefined || value.interval.operation_id === tracing.recording));
      if (tracing.action === "status") return { ...observed, result: { resource: control.resource, instances,
        busy: instances.some((value) => value.busy), interval: owned.length === 1 ? owned[0].interval : null } };
      if (!owned.length) throw new Error(instances.some((value) => value.busy && value.interval === null) ? "browser_trace_owned_by_peer" : "browser_trace_not_active");
      if (owned.length !== 1) throw new Error("browser_trace_selection_required");
      selected = owned[0];
      active = selected.interval;
      requestBody = { kind: "tracing_stop", caller: options.controller,
        authority: { ...browserControllerAuthority(control, options, operationId),
          instance_id: selected.instance_id, recording: active.operation_id } };
    }
    // Resolve local write intent before the stop effect. Backend filenames are hints only.
    const output = tracing.action === "stop" ? await destination({ ...tracing, mode: active.mode }, operationId, local) : undefined;
    const response = await request(requestBody);
    progress.result = response.result;
    if (response?.result?.response?.success !== true) return response;
    const data = response.result.response.data;
    const recorded = interval(data?.interval, control.resource);
    if (tracing.action === "start") {
      if (data.started !== true || recorded.operation_id !== operationId || recorded.mode !== tracing.mode || recorded.scope !== tracing.scope || !sameBrowserPage(recorded.origin, page)) throw new Error("browser_response_invalid");
    } else {
      if (data.stopped !== true || recorded.operation_id !== active.operation_id || recorded.scope !== active.scope || recorded.mode !== active.mode
          || recorded.cleanup_confirmed !== true || recorded.phase !== "finished" || data.artifact?.mimeType !== "application/json"
          || !sameBrowserPage(recorded.origin, active.origin) || !sameBrowserPage(data.artifact.page, active.origin)
          || !Number.isSafeInteger(data.eventCount) || data.eventCount < 0 || typeof data.dataLoss !== "boolean") throw new Error("browser_response_invalid");
      Object.assign(response.result, await downloadBrowserArtifact(request, operationId, output));
      response.result.path = output;
    }
    return response;
  } catch (error) {
    return { ...progress, error: error?.name === "Error" && error.message.startsWith("browser_")
      ? { code: error.message } : backendRequestFailure(error, local.profile) };
  }
}
