import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { appControlDirectory, loadAppControlDescriptor } from "./app-control-location.mjs";
import { requestAppControl, publicAppControlIdentity } from "./app-control-client.mjs";
import { loadSessionClientProjection } from "./client-registry.mjs";
import { resolveRunPresentationTarget } from "./run-presentation.mjs";
import { isDureDomainIdV1, isDureBackendProfileIdV1 } from "./contracts/protocol-identity.mjs";
import { browserCurrentPage } from "./browser-action-authority.mjs";
import { browserTabLabel } from "./browser-tabs.mjs";
import { browserResourceSelection, assertBrowserResource } from "./browser-resource-target.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";

function fail(code) { throw Object.assign(new Error(code), { code }); }
function sameResource(left, right) {
  return ["resource_id", "generation", "workspace_id"].every((key) => isDureDomainIdV1(left?.[key]) && left[key] === right?.[key]);
}

/** The app owns presentation in its exact Space/window. Both tab creation and
 * optional tab-switch presentation use this authenticated, public-identity path. */
export function resolveBrowserPresentation({ spaceSelector, sourceEnvironment = process.env, appControl = {} }) {
  const directory = appControl.directory ?? appControlDirectory(sourceEnvironment);
  const descriptor = appControl.descriptor ?? loadAppControlDescriptor(directory);
  const registry = appControl.registry ?? loadSessionClientProjection({ registryPath: join(directory, "agents.json") });
  const target = resolveRunPresentationTarget({ spaceSelector, environment: sourceEnvironment, registry });
  if (target.state !== "requested") fail("browser_space_required");
  const client = publicAppControlIdentity(descriptor);
  return { target, client, async request(profile, resource, kind, pageId) {
    if (!isDureBackendProfileIdV1(profile.id) || !isDureDomainIdV1(profile.expected?.backendId) || !isDureDomainIdV1(profile.expected?.generation)) fail("browser_backend_identity_required");
    if (!sameResource(resource, resource)) fail("browser_response_invalid");
    const response = await (appControl.request ?? requestAppControl)({ descriptor, path: "/browser/present",
      body: { schemaVersion: 1, backendProfileId: profile.id, backend: { id: profile.expected.backendId, generation: profile.expected.generation },
        resource, spaceId: target.spaceId, windowLabel: target.windowLabel, kind, ...(pageId === undefined ? {} : { pageId }) } });
    if (response?.ok !== true) throw Object.assign(new Error(response?.error?.message ?? "Browser presentation failed."), { code: response?.error?.code ?? "browser_presentation_failed" });
    const receipt = response.presentation;
    if (receipt?.state !== (kind === "prepare" ? "ready" : "requested") || receipt.spaceId !== target.spaceId ||
        receipt.windowLabel !== target.windowLabel || !sameResource(receipt.resource, resource) ||
        (kind === "present" && (receipt.pageId !== pageId || !isDureDomainIdV1(receipt.panelId)))) fail("browser_presentation_response_invalid");
    return receipt;
  } };
}

/** A focused switch composes the existing tab command; --focus never creates
 * a tab or replaces Host controller/sequence authority with app state. */
export async function collectBrowserTabFocus({ options, resolveBackend, requestBackend, cwd, sourceEnvironment, appControl, run }) {
  const operationId = options.operationId ?? randomUUID();
  let backend;
  let runtime;
  let presentation;
  try {
    const allowed = ["positional", "focus", "space", "backend", "resource", "defaultResource", "page", "index", "label", "controller", "epoch", "operationId"];
    if (options.positional.length > 3 || options.space === "" || Object.keys(options).some((key) => !allowed.includes(key))) fail("browser_command_invalid");
    if (options.page === undefined && options.index === undefined && options.label === undefined) fail("browser_page_required");
    if (options.label !== undefined) {
      browserTabLabel(options.label);
      if (options.index !== undefined) fail("browser_command_invalid");
    }
    if (options.page !== undefined && !isDureDomainIdV1(options.page)) fail("browser_page_required");
    if (options.index !== undefined && (!/^(0|[1-9][0-9]*)$/.test(options.index) || !Number.isSafeInteger(Number(options.index)) || Number(options.index) > 127)) fail("browser_tab_index_invalid");
    const resourceId = options.positional[2];
    if (resourceId !== undefined && (!isDureDomainIdV1(resourceId) || ["resource", "defaultResource"].some((key) => options[key] !== undefined))) fail("browser_command_invalid");
    browserResourceSelection({ ...options, positional: [...options.positional] });
    const show = ["show", ...(resourceId === undefined ? [] : [resourceId])];
    if (options.resource !== undefined) show.push("--resource", options.resource);
    presentation = resolveBrowserPresentation({ spaceSelector: options.space, sourceEnvironment, appControl });
    backend = await resolveBackend({ backend: options.backend, backendSpecified: options.backend !== undefined });
    if (!backend?.profile || backend.error) return { ok: false, operation_id: operationId, error: backendRequestFailure(backend?.error, backend?.profile) };
    const context = { resolveBackend: async () => backend, requestBackend, cwd, sourceEnvironment };
    const observed = await run({ ...context, args: show });
    if (!observed.ok) return { ...observed, operation_id: operationId };
    const resource = observed.result?.control?.resource;
    await presentation.request(backend.profile, resource, "prepare");
    const args = ["tab", "switch", resource.resource_id, "--idempotency-key", operationId];
    for (const key of ["page", "index", "label", "controller", "epoch"]) if (options[key] !== undefined) args.push(`--${key}`, options[key]);
    let selectedPage;
    runtime = await run({ ...context, args, requestBackend: async (selected, request, transport) => {
      if (request.body?.kind === "action" && request.body.action?.kind === "select_page") selectedPage = request.body.authority.page.page_id;
      const response = await requestBackend(selected, request, transport);
      assertBrowserResource(resource, request.body?.kind, response.result);
      return response;
    } });
    if (!runtime.ok) return runtime;
    const page = browserCurrentPage({ resource, current_page: runtime.result?.control?.current_page });
    if (page.page_id !== selectedPage) fail("browser_tab_target_mismatch");
    const receipt = await presentation.request(backend.profile, resource, "present", page.page_id);
    return { ...runtime, presentation: { ...receipt, client: presentation.client } };
  } catch (error) {
    const failure = error?.code ? { code: error.code, message: error.message } :
      error?.message?.startsWith("browser_") ? { code: error.message } : backendRequestFailure(error, backend?.profile);
    return { ok: false, operation_id: operationId, error: failure,
      ...(runtime ? { runtime, presentation: { ...presentation.target, state: "failed", client: presentation.client, error: failure } } : {}) };
  }
}
