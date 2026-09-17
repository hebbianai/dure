import { randomUUID } from "node:crypto";
import { resolveBrowserPresentation } from "./browser-presentation.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { browserCurrentPage } from "./browser-action-authority.mjs";
import { browserWorkspaceSelection, assertBrowserWorkspaceResource } from "./browser-workspace-target.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";

function fail(code) { throw Object.assign(new Error(code), { code }); }
function commandArguments(options) {
  const allowed = ["positional", "url", "space", "backend", "resource", "workspace", "worktree", "page", "controller", "epoch", "operationId", "profileId"];
  if (Object.keys(options).some((key) => !allowed.includes(key)) || options.positional.length > 2 ||
      (options.positional.length === 2 && options.url !== undefined) || options.space === "") fail("browser_command_invalid");
  const url = options.positional[1] ?? options.url;
  if (typeof url !== "string" || Buffer.byteLength(url) > 16_384 || /[\u0000-\u001f\u007f]/.test(url)) fail("browser_url_invalid");
  let parsed;
  try { parsed = new URL(url); } catch { fail("browser_url_invalid"); }
  if (!["http:", "https:"].includes(parsed.protocol)) fail("browser_url_invalid");
  const selected = { ...options, positional: ["show"] };
  if (options.resource === undefined && options.workspace === undefined && options.worktree === undefined) selected.worktree = "current";
  // Validate selector conflicts before reading client state or contacting a backend.
  browserWorkspaceSelection({ ...selected });
  if (options.resource !== undefined && !isDureDomainIdV1(options.resource)) fail("browser_command_invalid");
  for (const key of ["page", "controller", "operationId"]) {
    if (options[key] !== undefined && !isDureDomainIdV1(options[key])) fail("browser_command_invalid");
  }
  if (options.profileId !== undefined && !options.profileId.trim()) fail("browser_command_invalid");
  const show = ["show"];
  for (const key of ["resource", "workspace", "worktree"]) if (selected[key] !== undefined) show.push(`--${key}`, selected[key]);
  return { url, show };
}

/** App presentation composes the existing Host tab transaction. The operation
 * receipt survives a missing client response; this function never compensates
 * by deleting/recreating a page or acquiring a second source of control. */
export async function collectBrowserOpenUrl({ options, resolveBackend, requestBackend, cwd, sourceEnvironment = process.env, appControl = {}, run }) {
  const operationId = options.operationId ?? randomUUID();
  let backend;
  let runtime;
  let presentationClient;
  try {
    const { url, show } = commandArguments(options);
    presentationClient = resolveBrowserPresentation({ spaceSelector: options.space, sourceEnvironment, appControl });
    backend = await resolveBackend({ backend: options.backend, backendSpecified: options.backend !== undefined });
    if (!backend?.profile || backend.error) return { ok: false, operation_id: operationId, error: backendRequestFailure(backend?.error, backend?.profile) };
    const profile = backend.profile;
    const context = { resolveBackend: async () => backend, requestBackend, cwd, sourceEnvironment };
    const observed = await run({ ...context, args: show });
    if (!observed.ok) return { ...observed, operation_id: operationId };
    const resource = observed.result?.control?.resource;
    const present = (kind, pageId) => presentationClient.request(profile, resource, kind, pageId);
    await present("prepare");
    const args = ["tab", "create", resource.resource_id, url, "--idempotency-key", operationId];
    for (const [key, flag] of [["page", "--page"], ["controller", "--controller"], ["epoch", "--epoch"], ["profileId", "--profile"]]) {
      if (options[key] !== undefined) args.push(flag, options[key]);
    }
    runtime = await run({ ...context, args, requestBackend: async (selected, request, transport) => {
      const response = await requestBackend(selected, request, transport);
      assertBrowserWorkspaceResource(resource, request.body?.kind, response.result);
      return response;
    } });
    if (!runtime.ok) return runtime;
    // The creation receipt's page is owned by the admitted operation. Current
    // page selection or a later tab census cannot substitute another page.
    const page = browserCurrentPage({ resource, current_page: runtime.result?.response?.data?.page });
    const presentation = await present("present", page.page_id);
    return { ...runtime, presentation: { ...presentation, client: presentationClient.client } };
  } catch (error) {
    const failure = error?.code ? { code: error.code, message: error.message } :
      error?.message?.startsWith("browser_") ? { code: error.message } : backendRequestFailure(error, backend?.profile);
    return { ok: false, operation_id: operationId, error: failure,
      ...(runtime ? { runtime, presentation: { ...presentationClient.target, state: "failed", client: presentationClient.client, error: failure } } : {}) };
  }
}
