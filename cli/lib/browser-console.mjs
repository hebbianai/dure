import { browserActionAuthority, browserCurrentPage, sameBrowserPage } from "./browser-action-authority.mjs";

export function browserConsole(values, options, implicitController = false, kind) {
  if (values.length > 1 || (values.length === 1 && values[0] !== "clear")) throw new Error("browser_console_invalid");
  if (options.page !== undefined && !options.page) throw new Error("browser_page_required");
  const clear = values[0] === "clear";
  if (clear && (options.limit !== undefined || options.before !== undefined)) throw new Error("browser_console_invalid");
  if (clear && !implicitController && (!options.controller || !options.epoch)) throw new Error("browser_controller_required");
  const limit = options.limit === undefined ? 100 : Number(options.limit);
  if ((options.limit !== undefined && !/^[1-9][0-9]*$/.test(options.limit)) || !Number.isSafeInteger(limit) || limit < 1) throw new Error("browser_console_limit_invalid");
  const before = options.before;
  if (before !== undefined && (!/^[1-9][0-9]{0,19}$/.test(before) || BigInt(before) > 18446744073709551615n)) throw new Error("browser_console_cursor_invalid");
  return { clear, query: { limit, ...(before === undefined ? {} : { before }), ...(kind === undefined ? {} : { kind }) } };
}

export async function performBrowserConsole(request, resourceId, console, options, operationId) {
  const control = (await request({ kind: "control_state", resource_id: resourceId })).result;
  if (control?.resource?.resource_id !== resourceId) throw new Error("browser_resource_mismatch");
  const current = options.page === undefined ? browserCurrentPage(control) : undefined;
  const pageId = options.page ?? current.page_id;
  const observed = await request({ kind: "console", resource: control.resource, page_id: pageId, query: console.query });
  if (observed?.error) return observed;
  const page = observed?.result?.page;
  if (["resource_id", "generation", "workspace_id"].some((key) => page?.resource?.[key] !== control.resource[key]) || page?.page_id !== pageId || (current && !sameBrowserPage(current, page))) throw new Error("browser_response_invalid");
  if (!console.clear) return observed;
  return request({ kind: "action", caller: options.controller,
    authority: browserActionAuthority(control, page, options, operationId), action: { kind: "console_clear", ...(console.query.kind === undefined ? {} : { entry_kind: console.query.kind }) } });
}
