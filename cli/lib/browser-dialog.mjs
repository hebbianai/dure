import { browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";

export function browserDialog(values, options) {
  const [kind, text] = values;
  if (!(["status", "dismiss"].includes(kind) && values.length === 1)
      && !(kind === "accept" && values.length >= 1 && values.length <= 2 && (text === undefined || Buffer.byteLength(text, "utf8") <= 65536))) {
    throw new Error("browser_dialog_invalid");
  }
  if (options.page !== undefined && !options.page) throw new Error("browser_page_required");
  return kind === "status" ? { status: true } : { response: { kind, ...(text === undefined ? {} : { text }) } };
}

export async function performBrowserDialog(request, resourceId, dialog, options, operationId) {
  let current;
  if (options.page === undefined) {
    const control = (await request({ kind: "control_state", resource_id: resourceId })).result;
    if (control?.resource?.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
    current = browserCurrentPage(control);
  }
  const pageId = options.page ?? current.page_id;
  // Ordinary page observation waits for the input that a dialog can suspend.
  const observed = await request({ kind: "dialog_state", resource_id: resourceId, page_id: pageId });
  const view = observed.result;
  if (view?.control?.resource?.resource_id !== resourceId || view?.page?.page_id !== pageId || (current && !sameBrowserPage(current, view.page))) throw new Error("browser_response_invalid");
  if (dialog.status) return observed;
  const lease = view.control.controller;
  if (!lease || lease.controller_id !== options.controller || lease.epoch !== options.epoch) throw new Error("browser_controller_changed");
  if (!view.dialog) throw new Error("browser_dialog_changed");
  return request({ kind: "dialog_respond", caller: options.controller,
    authority: { lease, page: view.page, operation_id: operationId, command_sequence: view.control.next_command_sequence },
    dialog: view.dialog.identity, response: dialog.response });
}
