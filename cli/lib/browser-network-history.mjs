import { browserActionAuthority, browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";
import { networkQueryOptions } from "./browser-network-query.mjs";

export function browserNetworkHistory(values, options, implicitController) {
  if (!values.length) return;
  if ([...networkQueryOptions, "status", "limit"].some((key) => options[key] !== undefined)) throw new Error("browser_network_command_invalid");
  if (values.length === 1 && values[0] === "clear") {
    if (!implicitController && (!options.controller || !options.epoch)) throw new Error("browser_controller_required");
    return { clear: true };
  }
  if (values.length !== 2 || values[0] !== "request" || !/^[1-9][0-9]{0,19}$/.test(values[1]) || BigInt(values[1]) > 18446744073709551615n) throw new Error("browser_network_sequence_invalid");
  return { sequence: values[1] };
}

export async function performBrowserNetworkHistory(request, resourceId, history, options, operationId) {
  const control = (await request({ kind: "control_state", resource_id: resourceId }))?.result;
  if (control?.resource?.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
  const current = options.page === undefined ? browserCurrentPage(control) : undefined;
  const pageId = options.page ?? current.page_id;
  const observed = await request({ kind: "network_state", resource: control.resource, page_id: pageId });
  if (observed?.error) return observed;
  const page = observed?.result?.page;
  if (!pageId || page?.page_id !== pageId || ["resource_id", "generation", "workspace_id"].some((key) => page?.resource?.[key] !== control.resource[key])
      || (current && !sameBrowserPage(current, page))) throw new Error("browser_response_invalid");
  if (history.clear) return request({ kind: "action", caller: options.controller,
    authority: browserActionAuthority(control, page, options, operationId), action: { kind: "network_clear" } });
  const result = await request({ kind: "network_detail", page, sequence: history.sequence, operation_id: operationId, export_file: options.output !== undefined });
  if (result?.error) return result;
  if (!sameBrowserPage(result?.result?.page, page) || result?.result?.request?.sequence !== history.sequence) throw new Error("browser_response_invalid");
  return result;
}
