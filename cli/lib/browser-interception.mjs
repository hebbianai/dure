import { browserActionAuthority, browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";

export const interceptionOptions = ["patterns", "abort", "body", "status", "contentType", "responseHeaders", "resourceTypes"];

export function browserInterception(values, options, implicitController = false) {
  const [command, pattern] = values;
  if (!["enable", "disable", "list", "remove"].includes(command)
      || values.length < 1 || values.length > (command === "enable" || command === "remove" ? 2 : 1)
      || (command === "remove" && values.length !== 2)
      || (values.length === 2 && !pattern)) throw new Error("browser_interception_command_invalid");
  if (options.page !== undefined && !options.page) throw new Error("browser_page_required");
  if (command !== "list" && !implicitController && (!options.controller || !options.epoch)) throw new Error("browser_controller_required");
  if (command !== "enable") {
    if (interceptionOptions.some((key) => options[key] !== undefined)) throw new Error("browser_interception_options_invalid");
    return { command, action: command === "remove" ? { kind: "remove", pattern } : { kind: "disable" } };
  }
  if (pattern !== undefined && options.patterns !== undefined) throw new Error("browser_interception_options_invalid");
  const responding = options.body !== undefined;
  if ((options.abort && responding) || (!responding && ["status", "contentType", "responseHeaders"].some((key) => options[key] !== undefined))) throw new Error("browser_interception_response_invalid");
  let effect = { kind: options.abort ? "abort" : "continue" };
  if (responding) {
    const status = Number(options.status ?? 200);
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error("browser_interception_response_invalid");
    const headers = options.responseHeaders === undefined ? {} : JSON.parse(options.responseHeaders);
    if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some((value) => typeof value !== "string")) throw new Error("browser_interception_response_invalid");
    if (options.contentType !== undefined) {
      if (Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) throw new Error("browser_interception_response_invalid");
      headers["Content-Type"] = options.contentType;
    }
    effect = { kind: "respond", body: options.body, status, headers };
  }
  return { command, action: { kind: "enable", rule: {
    patterns: pattern === undefined ? (options.patterns ?? "*").split(",").map((value) => value.trim()) : [pattern],
    resource_types: options.resourceTypes === undefined ? [] : options.resourceTypes.split(",").map((type) => type.trim()), effect,
  } } };
}

export async function performBrowserInterception(request, resourceId, interception, options, operationId) {
  const control = (await request({ kind: "control_state", resource_id: resourceId })).result;
  if (control?.resource?.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
  const current = options.page === undefined ? browserCurrentPage(control) : undefined;
  const pageId = options.page ?? current.page_id;
  const state = await request({ kind: "interception_state", resource: control.resource, page_id: pageId });
  const page = state?.result?.page;
  if (["resource_id", "generation", "workspace_id"].some((key) => page?.resource?.[key] !== control.resource[key])
      || page?.page_id !== pageId || (current && !sameBrowserPage(current, page))) throw new Error("browser_response_invalid");
  if (interception.command === "list") return state;
  return request({ kind: "action", caller: options.controller,
    authority: browserActionAuthority(control, page, options, operationId), action: { kind: "interception", action: interception.action } });
}
