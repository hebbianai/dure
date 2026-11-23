import {
	projectCliSpaceReceipt,
	resolveCliSpaceId,
} from "@/lib/cli/cliSpaceIdentity";
import type { CliSpaceOwnerRoute } from "@/lib/cli/cliSpaceOwnerRouting";
import { containsCliControlCharacter } from "@/lib/cli/cliTextBoundary";
import { localFilePanePath } from "../../../cli/lib/contracts/local-file-pane.mjs";

export interface CliDesktopPaneRequest {
	reqId: string;
	action: string;
	params: Record<string, unknown>;
}

export interface CliDesktopPaneDependencies {
	routeToSpaceOwner(
		request: CliDesktopPaneRequest,
	): Promise<CliSpaceOwnerRoute>;
	claim(reqId: string): Promise<boolean>;
	complete(
		reqId: string,
		result: Record<string, unknown>,
		action: string,
	): Promise<unknown>;
	closePanel(panelId: string, spaceId?: string): Promise<object | null>;
	movePanel(
		panelId: string,
		fromSpaceId: string,
		spaceId: string,
	): Promise<object>;
	addSpace(name?: string, select?: boolean): string;
	waitForSpace(spaceId: string): Promise<unknown | undefined>;
	removeSpace(spaceId: string): void;
	spaceName(spaceId: string): string | undefined;
	openMobile(spaceId: string): Promise<object>;
	openFile(spaceId: string, path: string): Promise<object>;
	/** Whether this window owns the presentation window (the main window). */
	ownsFilePresentation(): boolean;
	presentFile(path: string, presenterSessionId?: string): Promise<object>;
}

function errorPayload(error: unknown, fallbackCode: string) {
	const code =
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: fallbackCode;
	return {
		code,
		message: error instanceof Error ? error.message : String(error),
	};
}

function paneCloseTarget(params: Record<string, unknown>) {
	return {
		panelId: String(params.targetPanelId ?? params.panelId ?? "").trim(),
		spaceId: resolveCliSpaceId(params),
	};
}

async function handlePaneClose(
	request: CliDesktopPaneRequest,
	dependencies: CliDesktopPaneDependencies,
) {
	let target: ReturnType<typeof paneCloseTarget>;
	try {
		target = paneCloseTarget(request.params);
		if ((await dependencies.routeToSpaceOwner(request)).kind === "forwarded")
			return null;
	} catch (error) {
		if (!(await dependencies.claim(request.reqId))) return null;
		return {
			ok: false,
			error: errorPayload(error, "invalid_request"),
		};
	}
	if (!(await dependencies.claim(request.reqId))) return null;
	const { panelId, spaceId } = target;
	if (!panelId) {
		return {
			ok: false,
			error: {
				code: "invalid_request",
				message: "targetPanelId is required",
			},
		};
	}
	try {
		const closed = await dependencies.closePanel(panelId, spaceId);
		if (!closed) {
			return {
				ok: false,
				error: {
					code: "pane_not_found",
					message: spaceId
						? `panel ${panelId} was not found in Space ${spaceId}`
						: `panel ${panelId} was not found in any Space`,
				},
			};
		}
		return { ok: true, closed: { panelId, ...closed } };
	} catch (error) {
		return {
			ok: false,
			error: errorPayload(error, "pane_close_failed"),
		};
	}
}

async function handlePaneMove(
	request: CliDesktopPaneRequest,
	dependencies: CliDesktopPaneDependencies,
) {
	let claimed = false;
	try {
		const panelId =
			typeof request.params.targetPanelId === "string"
				? request.params.targetPanelId.trim()
				: "";
		const fromSpaceId =
			typeof request.params.fromSpaceId === "string"
				? request.params.fromSpaceId.trim()
				: "";
		const spaceId = resolveCliSpaceId(request.params, { required: true });
		if (!panelId || !fromSpaceId || !spaceId)
			throw new Error(
				"pane move requires targetPanelId, fromSpaceId and spaceId",
			);
		if ((await dependencies.routeToSpaceOwner(request)).kind === "forwarded")
			return null;
		claimed = await dependencies.claim(request.reqId);
		if (!claimed) return null;
		return {
			ok: true,
			pane: await dependencies.movePanel(panelId, fromSpaceId, spaceId),
		};
	} catch (error) {
		if (!claimed && !(await dependencies.claim(request.reqId))) return null;
		return {
			ok: false,
			error: errorPayload(
				error,
				claimed ? "pane_move_failed" : "invalid_request",
			),
		};
	}
}

async function handleSpaceCreate(
	request: CliDesktopPaneRequest,
	dependencies: CliDesktopPaneDependencies,
) {
	if (!(await dependencies.claim(request.reqId))) return null;
	if (
		request.params.select !== undefined &&
		typeof request.params.select !== "boolean"
	) {
		return {
			ok: false,
			error: { code: "invalid_request", message: "select must be a boolean" },
		};
	}
	// Omitted selection preserves older CLI/MCP clients and desktop.create.
	const select = request.params.select !== false;
	const name = String(request.params.name ?? "").trim() || undefined;
	const spaceId = dependencies.addSpace(name, select);
	if (select && !(await dependencies.waitForSpace(spaceId))) {
		dependencies.removeSpace(spaceId);
		const legacyAction = request.action === "desktop.create";
		return {
			ok: false,
			error: {
				code: legacyAction ? "desktop_mount_timeout" : "space_mount_timeout",
				message: `${legacyAction ? "desktop" : "Space"} ${spaceId} did not publish its Dockview`,
			},
		};
	}
	const identity = {
		spaceId,
		desktopId: spaceId,
		name: dependencies.spaceName(spaceId),
		// A background Space needs no Dockview or terminal to exist.
		mounted: select,
	};
	return {
		ok: true,
		space: identity,
		/** @deprecated Use `space`. */
		desktop: identity,
	};
}

function invalidRequest(message: string) {
	return Object.assign(new Error(message), { code: "invalid_request" });
}

/** File panes and the presentation window open only local paths on the app host. */
function localFilePath(params: Record<string, unknown>): string {
	if (
		(params.source !== undefined && params.source !== "local") ||
		(params.hostId !== undefined && params.hostId !== "local") ||
		params.sessionId !== undefined
	) {
		throw invalidRequest(
			"file panes require a local path on the connected app host",
		);
	}
	return localFilePanePath(params.path, { absolute: true });
}

function optionalSessionId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > 512 ||
		containsCliControlCharacter(value)
	) {
		throw invalidRequest("presenterSessionId is invalid");
	}
	return value.trim();
}

/** The window is not in a Space: only its owning window claims the request. */
async function handleFilePresentation(
	request: CliDesktopPaneRequest,
	dependencies: CliDesktopPaneDependencies,
) {
	let path: string;
	let presenterSessionId: string | undefined;
	try {
		if (request.params.tool !== "file")
			throw invalidRequest("window placement presents a file");
		if (
			request.params.spaceId !== undefined ||
			request.params.desktopId !== undefined
		)
			throw invalidRequest("window placement does not take a Space");
		path = localFilePath(request.params);
		presenterSessionId = optionalSessionId(request.params.presenterSessionId);
	} catch (error) {
		if (!(await dependencies.claim(request.reqId))) return null;
		return { ok: false, error: errorPayload(error, "invalid_request") };
	}
	if (
		!dependencies.ownsFilePresentation() ||
		!(await dependencies.claim(request.reqId))
	)
		return null;
	try {
		return {
			ok: true,
			window: await dependencies.presentFile(path, presenterSessionId),
		};
	} catch (error) {
		return { ok: false, error: errorPayload(error, "file_presentation_failed") };
	}
}

async function handlePaneOpen(
	request: CliDesktopPaneRequest,
	dependencies: CliDesktopPaneDependencies,
) {
	if (request.params.placement === "window")
		return handleFilePresentation(request, dependencies);
	let claimed = false;
	try {
		if (request.params.placement !== undefined)
			throw invalidRequest("placement must be window when given");
		const spaceId = resolveCliSpaceId(request.params, { required: true });
		const { tool } = request.params;
		if (!spaceId || (tool !== "mobile" && tool !== "file"))
			throw new Error(
				"pane open requires tool mobile or file and an exact Space",
			);
		const path = tool === "file" ? localFilePath(request.params) : undefined;
		if ((await dependencies.routeToSpaceOwner(request)).kind === "forwarded")
			return null;
		claimed = await dependencies.claim(request.reqId);
		if (!claimed) return null;
		return {
			ok: true,
			pane: {
				spaceId,
				...(path === undefined
					? await dependencies.openMobile(spaceId)
					: await dependencies.openFile(spaceId, path)),
			},
		};
	} catch (error) {
		if (!claimed && !(await dependencies.claim(request.reqId))) return null;
		return { ok: false, error: errorPayload(error, "pane_open_failed") };
	}
}

/**
 * Dispatch the desktop/pane lifecycle subset without importing Store or
 * Dockview. Effects are explicit dependencies so parsing and completion
 * behavior remain testable as one deterministic boundary.
 */
export async function dispatchCliDesktopPaneRequest(
	request: CliDesktopPaneRequest,
	dependencies: CliDesktopPaneDependencies,
): Promise<boolean> {
	let result: Record<string, unknown> | null;
	if (request.action === "pane.close") {
		result = await handlePaneClose(request, dependencies);
	} else if (request.action === "pane.move") {
		result = await handlePaneMove(request, dependencies);
	} else if (request.action === "pane.open") {
		result = await handlePaneOpen(request, dependencies);
	} else if (
		request.action === "space.create" ||
		request.action === "desktop.create"
	) {
		result = await handleSpaceCreate(request, dependencies);
	} else {
		return false;
	}
	if (result) {
		await dependencies.complete(
			request.reqId,
			projectCliSpaceReceipt(result) as Record<string, unknown>,
			request.action,
		);
	}
	return true;
}
