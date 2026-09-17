import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { DockviewApi } from "dockview-react";
import { readBrowserPaneBinding } from "@/lib/browser/browserPaneBinding";
import {
	type BrowserResourceIdentity,
	parseBrowserResource,
	sameBrowserResource,
} from "@/lib/browser/browserResourceContract";
import { t } from "@/lib/i18n";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import { sameDureBackendRouteAuthority } from "@/lib/ipc/dureBackendRoute";
import { createDureBrowserClient } from "@/lib/ipc/dureBrowser";
import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
} from "@/lib/ipc/dureProtocolIdentity";
import { isRecord } from "@/lib/payloadGuards";
import { requestDesktopPrewarm } from "@/lib/workspace/desktop/desktopPrewarm";
import { dockPanelParameters } from "@/lib/workspace/dock/dockPanelParameters";
import {
	getDockview,
	waitForDesktopDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { resolveEffectiveInterfaceMode } from "@/lib/workspace/pane/interfaceMode";
import { spaceWindowLabel } from "@/lib/workspace/window/windowLabel";
import { useStore } from "@/store";

interface BrowserPresentationTarget {
	readonly schemaVersion: 1;
	readonly backendProfileId: string;
	readonly backend: { readonly id: string; readonly generation: string };
	readonly resource: BrowserResourceIdentity;
	readonly spaceId: string;
	readonly windowLabel: string;
}

export type BrowserPresentationRequest = BrowserPresentationTarget &
	(
		| { readonly kind: "prepare" }
		| { readonly kind: "present"; readonly pageId: string }
	);

function fail(code: string, message: string): never {
	throw Object.assign(new Error(message), { code });
}

export function parseBrowserPresentationRequest(
	value: unknown,
): BrowserPresentationRequest {
	const keys = [
		"kind",
		"schemaVersion",
		"backendProfileId",
		"backend",
		"resource",
		"pageId",
		"spaceId",
		"windowLabel",
	];
	const resource = isRecord(value)
		? parseBrowserResource(value.resource)
		: undefined;
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !keys.includes(key)) ||
		value.schemaVersion !== 1 ||
		!isDureBackendProfileIdV1(value.backendProfileId) ||
		!isRecord(value.backend) ||
		Object.keys(value.backend).some(
			(key) => !["id", "generation"].includes(key),
		) ||
		!isDureDomainIdV1(value.backend.id) ||
		!isDureDomainIdV1(value.backend.generation) ||
		!resource ||
		(value.kind !== "prepare" && value.kind !== "present") ||
		(value.kind === "present"
			? !isDureDomainIdV1(value.pageId)
			: Object.keys(value).includes("pageId")) ||
		!isDureDomainIdV1(value.spaceId) ||
		typeof value.windowLabel !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(value.windowLabel)
	) {
		fail(
			"browser_presentation_invalid",
			"The Browser presentation identity is invalid.",
		);
	}
	return {
		schemaVersion: 1,
		backendProfileId: value.backendProfileId,
		backend: { id: value.backend.id, generation: value.backend.generation },
		resource,
		spaceId: value.spaceId,
		windowLabel: value.windowLabel,
		...(value.kind === "prepare"
			? { kind: "prepare" as const }
			: { kind: "present" as const, pageId: value.pageId as string }),
	};
}

interface Dependencies {
	assertSpace(request: BrowserPresentationRequest): void;
	resolveRoute: typeof resolveSelectedDureBackendRouteAuthority;
	client: typeof createDureBrowserClient;
	dockview(spaceId: string): DockviewApi | undefined;
	prepareSpace(spaceId: string): void;
	waitForSpace(spaceId: string): Promise<DockviewApi | undefined>;
	open: typeof openOrFocusPanel;
}

const dependencies: Dependencies = {
	assertSpace(request) {
		const state = useStore.getState();
		if (
			resolveEffectiveInterfaceMode(state.uiPrefs.interfaceMode).mode !== "pro"
		)
			fail("browser_pro_required", "Browser presentation requires Pro mode.");
		const space = state.spaces.find((row) => row.id === request.spaceId);
		if (
			!space ||
			spaceWindowLabel(space) !== request.windowLabel ||
			getCurrentWebviewWindow().label !== request.windowLabel
		)
			fail(
				"browser_presentation_window_changed",
				"The selected Space has moved or closed.",
			);
	},
	resolveRoute: resolveSelectedDureBackendRouteAuthority,
	client: createDureBrowserClient,
	dockview: getDockview,
	prepareSpace: requestDesktopPrewarm,
	waitForSpace: waitForDesktopDockview,
	open: openOrFocusPanel,
};

/** Show an existing Host page. This transaction owns only pane presentation;
 * it never creates a Browser, navigates, selects a Host page or acquires control. */
export async function presentBrowserPage(
	request: BrowserPresentationRequest,
	runtime: Dependencies = dependencies,
) {
	runtime.assertSpace(request);
	const authority = await runtime.resolveRoute(request.backendProfileId);
	if (
		authority.backend.id !== request.backend.id ||
		authority.backend.generation !== request.backend.generation
	)
		fail(
			"browser_presentation_backend_changed",
			"The selected backend generation has changed.",
		);
	const observation = await runtime.client(authority).observe(request.resource);
	if (!sameBrowserResource(observation.control.resource, request.resource))
		fail("browser_resource_mismatch", "The Browser generation has changed.");
	if (observation.observation_error)
		fail(
			"browser_presentation_observation_failed",
			observation.observation_error,
		);
	const page =
		request.kind === "present"
			? observation.pages.find(
					(row) =>
						row.page.page_id === request.pageId &&
						sameBrowserResource(row.page.resource, request.resource),
				)
			: undefined;
	if (request.kind === "present" && !page)
		fail(
			"browser_page_required",
			"The requested Browser page is no longer available.",
		);
	runtime.assertSpace(request);
	let api = runtime.dockview(request.spaceId);
	if (!api) {
		runtime.prepareSpace(request.spaceId);
		api = await runtime.waitForSpace(request.spaceId);
	}
	runtime.assertSpace(request);
	if (!api || runtime.dockview(request.spaceId) !== api)
		fail(
			"browser_presentation_workspace_changed",
			"The Space's mounted workspace has changed.",
		);
	const matches = api.panels.filter((panel) => {
		if (panel.api.component !== "browser") return false;
		const saved = readBrowserPaneBinding(dockPanelParameters(panel));
		return (
			!saved.error &&
			!saved.creation &&
			saved.binding?.resource &&
			sameBrowserResource(saved.binding.resource, request.resource) &&
			sameDureBackendRouteAuthority(saved.binding.authority, authority)
		);
	});
	if (matches.length > 1)
		fail(
			"browser_presentation_ambiguous",
			"This Space has multiple views of the Browser.",
		);
	if (request.kind === "prepare")
		return {
			state: "ready" as const,
			spaceId: request.spaceId,
			windowLabel: request.windowLabel,
			resource: request.resource,
		};
	if (!page)
		fail(
			"browser_page_required",
			"The requested Browser page is no longer available.",
		);
	const existing = matches[0];
	const panelId = existing?.id ?? createPaneId();
	const params = {
		url: page.url,
		browserBinding: {
			authority,
			workspaceId: request.resource.workspace_id,
			resource: request.resource,
			pageId: request.pageId,
			followCurrent: false,
		},
	};
	runtime.open({
		api,
		panelId,
		component: "browser",
		title: t("workspace.paneKind.browser"),
		params: existing ? params : { ...params, browserPurpose: "resource" },
		onExisting: (panel) => panel.api.updateParameters(params),
	});
	return {
		state: "requested" as const,
		spaceId: request.spaceId,
		windowLabel: request.windowLabel,
		panelId,
		resource: request.resource,
		pageId: request.pageId,
	};
}
