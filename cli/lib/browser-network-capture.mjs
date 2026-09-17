import { browserActionAuthority, browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";

export function browserNetworkCapture(values, options, implicitController = false) {
  if (values.length !== 1 || !["start", "stop", "status"].includes(values[0])) throw new Error("browser_capture_command_invalid");
  if (options.page !== undefined && !options.page) throw new Error("browser_page_required");
  const action = values[0];
  if (action !== "status" && !implicitController && (!options.controller || !options.epoch)) throw new Error("browser_controller_required");
  if (action !== "stop" && options.output !== undefined) throw new Error("browser_capture_output_invalid");
  return { action };
}

export async function performBrowserNetworkCapture(request, resourceId, capture, options, operationId) {
  const control = (await request({ kind: "control_state", resource_id: resourceId })).result;
  if (control?.resource?.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
  const current = options.page === undefined ? browserCurrentPage(control) : undefined;
  const pageId = options.page ?? current.page_id;
  const state = await request({ kind: "network_capture_state", resource: control.resource, page_id: pageId });
  const page = state?.result?.page;
  if (page?.resource?.resource_id !== resourceId || page?.page_id !== pageId || (current && !sameBrowserPage(current, page))) throw new Error("browser_response_invalid");
  if (capture.action === "status") return state;
  return request({ kind: "action", caller: options.controller,
    authority: browserActionAuthority(control, page, options, operationId), action: { kind: "network_capture", action: capture.action } });
}
