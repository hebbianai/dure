import {
	projectCliSpaceReceipt,
	resolveCliSpaceId,
} from "@/lib/cli/cliSpaceIdentity";
import type { CliSpaceOwnerRoute } from "@/lib/cli/cliSpaceOwnerRouting";

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
	addSpace(name?: string): string;
	waitForSpace(spaceId: string): Promise<unknown | undefined>;
	removeSpace(spaceId: string): void;
	spaceName(spaceId: string): string | undefined;
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

async function handleSpaceCreate(
	request: CliDesktopPaneRequest,
	dependencies: CliDesktopPaneDependencies,
) {
	if (!(await dependencies.claim(request.reqId))) return null;
	const name = String(request.params.name ?? "").trim() || undefined;
	const spaceId = dependencies.addSpace(name);
	if (!(await dependencies.waitForSpace(spaceId))) {
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
		mounted: true,
	};
	return {
		ok: true,
		space: identity,
		/** @deprecated Use `space`. */
		desktop: identity,
	};
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
