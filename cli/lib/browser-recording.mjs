import { createHash } from "node:crypto";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { browserActionAuthority, browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";
import { downloadBrowserArtifact } from "./browser-artifact.mjs";
import { recordingOutput } from "./browser-recording-output.mjs";

export function browserRecording(values, options, implicitController = false) {
  const [action, output, url] = values;
  const start = action === "start" || action === "restart";
  if (!["start", "stop", "restart", "status"].includes(action) || values.length < (start ? 2 : 1) || values.length > (start ? 3 : 1)) throw new Error("browser_recording_command_invalid");
  if (action !== "status" && !implicitController && (!options.controller || !options.epoch)) throw new Error("browser_controller_required");
  if (options.output !== undefined && action !== "stop") throw new Error("browser_recording_output_invalid");
  if (start && (!output || Buffer.byteLength(output) > 4096 || output.includes("\0"))) throw new Error("browser_recording_output_invalid");
  if (url !== undefined) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("browser_url_invalid"); }
    if (Buffer.byteLength(url) > 16_384 || (!(["http:", "https:"].includes(parsed.protocol)) && url !== "about:blank")) throw new Error("browser_url_invalid");
  }
  return { action, output, url };
}

const step = (operation, kind) => `record-v1:${createHash("sha256").update(JSON.stringify([operation, kind])).digest("hex")}`;

export async function performBrowserRecording(request, resourceId, recording, options, operationId, local) {
  const progress = { operation_id: operationId };
  try { return await perform(request, resourceId, recording, options, operationId, local, progress); }
  catch (error) {
    return { ...progress, error: error?.name === "Error" && error.message.startsWith("browser_")
      ? { code: error.message } : backendRequestFailure(error, local.profile) };
  }
}

async function perform(request, resourceId, recording, options, operationId, local, progress) {
  let target;
  const state = async () => {
    const control = (await request({ kind: "control_state", resource_id: resourceId })).result;
    if (control?.resource?.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
    if (target && ["resource_id", "generation", "workspace_id"].some((key) => control.resource[key] !== target.resource[key])) throw new Error("browser_resource_mismatch");
    const current = target === undefined && options.page === undefined ? browserCurrentPage(control) : undefined;
    const pageId = target?.page_id ?? options.page ?? current.page_id;
    const response = await request({ kind: "recording_state", resource: control.resource, page_id: pageId });
    const page = response?.result?.page;
    if (page?.page_id !== pageId || !sameBrowserPage({ ...page, resource: control.resource }, page) || (current && !sameBrowserPage(current, page))) throw new Error("browser_response_invalid");
    target ??= { resource: { ...control.resource }, page_id: pageId };
    return { control, page, response };
  };
  let observed = await state();
  if (recording.action === "status") return observed.response;
  const action = async (observed, operation, action) => {
    const authority = browserActionAuthority(observed.control, observed.page, options, operation);
    progress.operation_id = operation;
    const response = await request({ kind: "action", caller: options.controller, authority, action });
    progress.result = response.result;
    return response;
  };
  let previous;
  if (recording.action === "stop" || (recording.action === "restart" && observed.response.result.operation_id)) {
    const stoppedOperation = recording.action === "stop" ? operationId : step(operationId, "stop");
    const source = observed.response.result.operation_id;
    const destination = options.output ?? (source ? await recordingOutput(local.profile, observed.control.resource, source, undefined, local.environment, local.cwd) : undefined);
    const format = destination?.toLowerCase().endsWith(".webm") ? "webm" : "mp4";
    const stopped = await action(observed, stoppedOperation, { kind: "record", action: "stop", format });
    if (stopped?.result?.response?.success === true) {
      if (stopped.result.response.data?.recording_operation_id !== source) throw new Error("browser_response_invalid");
      if (stopped.result.response.data.artifact?.mimeType !== `video/${format}`) throw new Error("browser_response_invalid");
      Object.assign(stopped.result, await downloadBrowserArtifact(request, stoppedOperation, destination));
    }
    if (recording.action === "stop" || stopped?.result?.response?.success !== true) return stopped;
    previous = { operation_id: stoppedOperation, ...stopped.result };
    observed = await state();
  }
  browserActionAuthority(observed.control, observed.page, options, operationId);
  await recordingOutput(local.profile, observed.control.resource, operationId, recording.output, local.environment, local.cwd);
  const started = await action(observed, operationId, { kind: "record", action: "start" });
  if (previous && started.result) started.result.previous = previous;
  if (recording.url !== undefined && started?.result?.response?.success === true) {
    const current = await state();
    if (current.response.result.operation_id !== operationId) throw new Error("browser_recording_changed");
    const navigationOperation = step(operationId, "navigate");
    const navigation = await action(current, navigationOperation, { kind: "navigate", url: recording.url });
    started.result.navigation = { operation_id: navigationOperation, ...navigation.result };
    if (navigation?.result?.response?.success !== true) {
      return { ...started, operation_id: navigationOperation, error: { code: "browser_recording_navigation_failed" } };
    }
  }
  return started;
}
