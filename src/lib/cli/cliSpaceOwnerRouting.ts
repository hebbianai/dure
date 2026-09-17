import type { UnlistenFn } from "@tauri-apps/api/event";
import { emitTo } from "@tauri-apps/api/event";
import {
	getAllWebviewWindows,
	getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { resolveCliSpaceId } from "@/lib/cli/cliSpaceIdentity";
import type { CliRequest } from "@/lib/hmux/remote/remoteHmuxShellCliRequest";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { isDesktopWorkspaceWindowLabel } from "@/lib/workspace/desktop/desktopVisibilityLease";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import {
	collectWindowSamples,
	type WindowSampleRequest,
	type WindowSampleResponse,
} from "@/lib/workspace/window/windowSampleCollection";
import { useStore } from "@/store";

const SPACE_OWNER_REQUEST_EVENT = "dure://cli/space-owner/request";
const SPACE_OWNER_RESPONSE_EVENT = "dure://cli/space-owner/response";
const SPACE_OWNER_COLLECTION_TIMEOUT_MS = 500;

interface SpaceOwnerRequest extends WindowSampleRequest {
	spaceId: string;
}

export interface SpaceOwnerObservation {
	spaceId: string;
	windowLabel: string;
	mounted: boolean;
	active: boolean;
}

export type CliSpaceOwnerRoute =
	| { kind: "local"; spaceId?: string }
	| { kind: "forwarded" };

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOwnerRequest(value: unknown): SpaceOwnerRequest | undefined {
	if (!record(value)) return undefined;
	const { requestId, spaceId, replyWindowLabel } = value;
	return typeof requestId === "string" &&
		typeof spaceId === "string" &&
		typeof replyWindowLabel === "string"
		? { requestId, spaceId, replyWindowLabel }
		: undefined;
}

function parseOwnerObservation(
	value: unknown,
): SpaceOwnerObservation | undefined {
	if (!record(value)) return undefined;
	const { spaceId, windowLabel, mounted, active } = value;
	return typeof spaceId === "string" &&
		typeof windowLabel === "string" &&
		typeof mounted === "boolean" &&
		typeof active === "boolean"
		? { spaceId, windowLabel, mounted, active }
		: undefined;
}

function parseOwnerResponse(
	value: unknown,
): WindowSampleResponse<SpaceOwnerObservation> | undefined {
	if (!record(value) || typeof value.requestId !== "string") return undefined;
	const sample = parseOwnerObservation(value.sample);
	return sample ? { requestId: value.requestId, sample } : undefined;
}

function localObservation(spaceId: string): SpaceOwnerObservation {
	const state = useStore.getState();
	return {
		spaceId,
		windowLabel: getCurrentWebviewWindow().label,
		mounted:
			state.spaces.some((space) => space.id === spaceId) &&
			getDockview(spaceId) !== undefined,
		active: state.activeSpaceId === spaceId,
	};
}

export interface SpaceOwnerCollector {
	currentWindowLabel(): string;
	listWindowLabels(): Promise<string[]>;
	readLocal(spaceId: string): SpaceOwnerObservation;
	listenResponse(listener: (payload: unknown) => void): Promise<UnlistenFn>;
	emitRequest(windowLabel: string, request: SpaceOwnerRequest): Promise<void>;
}

const collector: SpaceOwnerCollector = {
	currentWindowLabel: () => getCurrentWebviewWindow().label,
	listWindowLabels: async () =>
		(await getAllWebviewWindows()).map((window) => window.label),
	readLocal: localObservation,
	listenResponse: (listener) =>
		listenWhenReady<unknown>(SPACE_OWNER_RESPONSE_EVENT, (event) =>
			listener(event.payload),
		),
	emitRequest: (windowLabel, request) =>
		emitTo(
			{ kind: "WebviewWindow", label: windowLabel },
			SPACE_OWNER_REQUEST_EVENT,
			request,
		),
};

function selectOwner(
	observations: readonly SpaceOwnerObservation[],
	currentWindowLabel: string,
): string | undefined {
	return observations
		.filter((observation) => observation.mounted)
		.sort(
			(left, right) =>
				Number(right.active) - Number(left.active) ||
				Number(right.windowLabel === currentWindowLabel) -
					Number(left.windowLabel === currentWindowLabel) ||
				left.windowLabel.localeCompare(right.windowLabel),
		)[0]?.windowLabel;
}

/** Resolve one mounted presentation owner without retaining a second Space
 * registry. Active ownership wins over a warm mount; ties are deterministic. */
export async function resolveMountedSpaceOwner(
	spaceId: string,
	dependencies: SpaceOwnerCollector = collector,
	timeoutMs = SPACE_OWNER_COLLECTION_TIMEOUT_MS,
): Promise<string | undefined> {
	const currentWindowLabel = dependencies.currentWindowLabel();
	const local = dependencies.readLocal(spaceId);
	if (local.mounted && local.active) return currentWindowLabel;
	const { samples } = await collectWindowSamples(
		{
			currentWindowLabel: () => dependencies.currentWindowLabel(),
			listWindowLabels: async () =>
				(await dependencies.listWindowLabels()).filter(
					isDesktopWorkspaceWindowLabel,
				),
			readLocal: () => local,
			listenResponse: (listener) => dependencies.listenResponse(listener),
			emitRequest: (windowLabel, request: SpaceOwnerRequest) =>
				dependencies.emitRequest(windowLabel, request),
		},
		(value) => {
			const response = parseOwnerResponse(value);
			return response?.sample.spaceId === spaceId ? response : undefined;
		},
		timeoutMs,
		(requestId, replyWindowLabel) => ({
			requestId,
			replyWindowLabel,
			spaceId,
		}),
	);
	return selectOwner([...samples.values()], currentWindowLabel);
}

export async function installCliSpaceOwnerReporter(): Promise<UnlistenFn> {
	return listenWhenReady<unknown>(SPACE_OWNER_REQUEST_EVENT, (event) => {
		const request = parseOwnerRequest(event.payload);
		if (!request) return;
		void emitTo(
			{ kind: "WebviewWindow", label: request.replyWindowLabel },
			SPACE_OWNER_RESPONSE_EVENT,
			{
				requestId: request.requestId,
				sample: localObservation(request.spaceId),
			},
		).catch(() => undefined);
	});
}

export interface CliSpaceOwnerRoutingDependencies {
	currentWindowLabel(): string;
	activeSpaceId(): string;
	resolveOwner(spaceId: string): Promise<string | undefined>;
	forward(windowLabel: string, request: CliRequest): Promise<void>;
}

const routingDependencies: CliSpaceOwnerRoutingDependencies = {
	currentWindowLabel: () => getCurrentWebviewWindow().label,
	activeSpaceId: () => useStore.getState().activeSpaceId,
	resolveOwner: (spaceId) => resolveMountedSpaceOwner(spaceId),
	forward: (windowLabel, request) =>
		emitTo(
			{ kind: "WebviewWindow", label: windowLabel },
			"cli:request",
			request,
		),
};

/** Route before broker claim. The selected owner receives the original request
 * exactly once and executes its existing presentation transaction. */
export async function routeCliRequestToSpaceOwner(
	request: Pick<CliRequest, "reqId" | "action" | "params">,
	dependencies: CliSpaceOwnerRoutingDependencies = routingDependencies,
): Promise<CliSpaceOwnerRoute> {
	const spaceId =
		resolveCliSpaceId(request.params) ??
		(request.action === "hmux.create"
			? dependencies.activeSpaceId()
			: undefined);
	if (!spaceId || typeof request.params.windowLabel === "string") {
		return { kind: "local", ...(spaceId ? { spaceId } : {}) };
	}
	const currentWindowLabel = dependencies.currentWindowLabel();
	const owner = await dependencies.resolveOwner(spaceId);
	if (!owner || owner === currentWindowLabel) {
		return { kind: "local", spaceId };
	}
	await dependencies.forward(owner, {
		reqId: request.reqId,
		action: request.action,
		params: { ...request.params, spaceId, windowLabel: owner },
	});
	return { kind: "forwarded" };
}
