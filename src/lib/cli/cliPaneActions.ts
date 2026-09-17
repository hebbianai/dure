import {
	paneActionSnapshot,
	preparePaneAction,
} from "@/lib/workspace/pane/paneActionRegistry";

export interface CliPaneActionRequest {
	reqId: string;
	action: string;
	params: Record<string, unknown>;
}

export interface CliPaneActionDependencies {
	claim(reqId: string): Promise<boolean>;
	complete(
		reqId: string,
		result: Record<string, unknown>,
		action: string,
	): Promise<unknown>;
	/** Only the main window answers for panes no window has mounted, after a
	 * grace period that lets the owning window claim first. */
	isFallbackWindow(): boolean;
	delay(milliseconds: number): Promise<void>;
}

const NOT_MOUNTED_GRACE_MS = 900;

function notMountedPayload(paneId: string) {
	return {
		ok: false,
		error: {
			code: "pane_not_found",
			message: `pane ${paneId} is not mounted in any window`,
			retryable: false,
			nextAction:
				"open the pane in a window, or inspect sessions with `dure ls`",
		},
	};
}

/** Every window receives the request; the one whose registry holds the pane
 * claims immediately, and the main window claims late only to turn silence
 * into a typed not-found instead of a transport timeout. */
export async function dispatchCliPaneActionRequest(
	request: CliPaneActionRequest,
	dependencies: CliPaneActionDependencies,
): Promise<boolean> {
	const { reqId, action, params } = request;
	if (action !== "pane.state" && action !== "pane.act") return false;
	const paneId = String(params.targetPanelId ?? params.panelId ?? "").trim();
	if (!paneId) {
		if (!(await dependencies.claim(reqId))) return true;
		await dependencies.complete(
			reqId,
			{
				ok: false,
				error: {
					code: "invalid_request",
					message: "targetPanelId is required",
					retryable: false,
				},
			},
			action,
		);
		return true;
	}

	const snapshot = paneActionSnapshot(paneId);
	if (!snapshot) {
		if (!dependencies.isFallbackWindow()) return true;
		await dependencies.delay(NOT_MOUNTED_GRACE_MS);
		if (paneActionSnapshot(paneId)) return true;
		if (!(await dependencies.claim(reqId))) return true;
		await dependencies.complete(reqId, notMountedPayload(paneId), action);
		return true;
	}

	if (action === "pane.state") {
		if (!(await dependencies.claim(reqId))) return true;
		const { readCliPaneDiagnostics } = await import("./cliPaneDiagnostics");
		const current = paneActionSnapshot(paneId);
		await dependencies.complete(
			reqId,
			current
				? {
						ok: true,
						pane: { ...current, diagnostics: readCliPaneDiagnostics(paneId) },
					}
				: notMountedPayload(paneId),
			action,
		);
		return true;
	}
	const actionId = String(params.actionId ?? "").trim();
	const run = preparePaneAction(paneId, actionId, params.arguments);
	if (!(await dependencies.claim(reqId))) return true;
	if (!actionId) {
		await dependencies.complete(
			reqId,
			{
				ok: false,
				error: {
					code: "invalid_request",
					message: "actionId is required",
					retryable: false,
					nextAction: snapshot.actions.length
						? `available actions: ${snapshot.actions.join(", ")}`
						: undefined,
				},
			},
			action,
		);
		return true;
	}
	const result = await run();
	const after = paneActionSnapshot(paneId);
	await dependencies.complete(
		reqId,
		result.ok
			? {
					ok: true,
					pane: {
						paneId,
						invoked: actionId,
						...(result.result ? { result: result.result } : {}),
						...(after ? { status: after.status } : {}),
					},
				}
			: { ok: false, error: result.error },
		action,
	);
	return true;
}
