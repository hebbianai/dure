import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { definePaneAction } from "../workspace/pane/paneAction";
import type { PaneActionEntry } from "../workspace/pane/paneActionRegistry";
import type { BrowserPaneBinding } from "./browserPaneBinding";
import type { BrowserPaneSession, BrowserPaneView } from "./browserPaneSession";
import type { BrowserControllerLease } from "./browserResourceContract";

function failureDetails(error: unknown) {
	if (error instanceof DureBackendRequestError)
		return { code: error.code, ...error.failure };
	return {
		code:
			error instanceof Error && /^browser_[a-z_]+$/.test(error.message)
				? error.message
				: "browser_control_not_transferred",
		kind: "local",
	};
}

function recoveryInstruction(code: string) {
	return code === "browser_controller_changed"
		? "Read this pane's state again and copy the fresh take-control expectedState before another request."
		: "Inspect this pane's saved resource and backend. Use reconnect to refresh the saved binding; do not recreate the browser or replay the request automatically.";
}

/** The mounted pane supplies the same handoff handler to its button and agents. */
export function browserPaneActions({
	paneId,
	session,
	binding,
	view,
	busy,
	error,
	reconnect,
	take,
}: {
	paneId: string;
	session?: BrowserPaneSession;
	binding?: BrowserPaneBinding;
	view: BrowserPaneView;
	busy: boolean;
	error?: unknown;
	reconnect: () => void;
	take: (expected: BrowserControllerLease | null) => Promise<void>;
}) {
	const failure = error || view.error;
	const diagnostic = failure ? failureDetails(failure) : undefined;
	const resource = session?.resource ?? binding?.resource;
	const control = view.control;
	const expected = control?.controller;
	const expectedState = JSON.stringify([resource, expected]);
	const unavailable =
		!session ||
		!control ||
		busy ||
		control.phase !== "ready" ||
		!!control.requested_controller;
	// An explicit handback targets this mounted session even in a hidden Space.
	// Visibility still gates page input and viewport fitting in the pane.
	const takeControl = definePaneAction(
		{
			description:
				"Give control to this browser pane. Its viewport fits the pane after transfer.",
			parameters: {
				expectedState: {
					type: "string",
					required: true,
					description: "Copy expectedState from this action's current values.",
				},
			},
			current: { expectedState },
			...(unavailable
				? {
						unavailable: {
							code: "browser_control_unavailable",
							message: "The browser pane is not ready to receive control.",
							retryable: false,
							nextAction: busy
								? "Wait for this pane's current operation, then inspect its state again."
								: recoveryInstruction(
										diagnostic?.code ?? "browser_control_unavailable",
									),
						},
					}
				: {}),
		},
		async (input) => {
			if (input.expectedState !== expectedState || !session || !control)
				return {
					outcome: "refused",
					error: {
						code: "browser_controller_changed",
						message: "Inspect the browser pane again before returning control.",
						retryable: false,
					},
				};
			try {
				await take(expected ?? null);
			} catch (caught) {
				const { code } = failureDetails(caught);
				return {
					outcome: "failed",
					error: {
						code,
						message: `Browser control was not confirmed: ${code}.`,
						retryable: false,
						nextAction: recoveryInstruction(code),
					},
				};
			}
			const current = session.read().control;
			const value = {
				resource,
				controller: current?.controller,
				revision: current?.revision,
				phase: current?.phase,
				requestedController: current?.requested_controller,
			};
			if (current?.requested_controller === session.controllerId)
				return { outcome: "pending", value };
			if (
				current?.controller?.controller_id === session.controllerId &&
				current.phase === "ready" &&
				!current.requested_controller
			)
				return {
					outcome:
						expected?.controller_id === session.controllerId
							? "unchanged"
							: "applied",
					value,
				};
			return {
				outcome: "failed",
				error: {
					code: "browser_control_not_transferred",
					message:
						"Control was not confirmed. Inspect the browser before retrying.",
					retryable: false,
					nextAction: recoveryInstruction("browser_control_not_transferred"),
				},
			};
		},
	);
	const reconnectAction = definePaneAction(
		{
			description:
				"Reconnect this browser pane to its saved backend and resource.",
			parameters: {},
			...(busy || view.submitting
				? {
						unavailable: {
							code: "browser_pane_busy",
							message: "Wait for the current browser operation to finish.",
							retryable: true,
						},
					}
				: {}),
		},
		async () => {
			reconnect();
			return { outcome: "pending" };
		},
	);
	const entry: PaneActionEntry = {
		paneId,
		status: failure ? "error" : !session ? "connecting" : "attached",
		error:
			failure instanceof Error
				? failure.message
				: failure
					? String(failure)
					: undefined,
		context: JSON.stringify({
			kind: "browser",
			resource,
			backend: binding?.authority.backend,
			profileId: binding?.authority.profileId,
			...(diagnostic
				? {
						failure: {
							...diagnostic,
							nextAction: recoveryInstruction(diagnostic.code),
						},
					}
				: {}),
			page: view.page,
			controller: expected,
			viewport: view.frame?.capture.viewport,
		}),
		actions: { "take-control": takeControl, reconnect: reconnectAction },
	};
	return { entry, takeControl };
}
